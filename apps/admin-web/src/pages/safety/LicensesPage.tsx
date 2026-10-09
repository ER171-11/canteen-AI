import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
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
  fetchFoodsafeCerts,
  fetchFoodsafeConfig,
  saveFoodsafeConfig,
  upsertFoodsafeCert,
} from '../../api'
import type {
  CertLevel,
  CertRow,
  CertThresholds,
  FoodsafeCertsResp,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const LEVEL_META: Record<CertLevel, { text: string; color: string }> = {
  expired: { text: '已逾期 · 禁营', color: COLORS.red },
  red: { text: '红 · 临期', color: COLORS.red },
  orange: { text: '橙 · 关注', color: COLORS.orange },
  yellow: { text: '黄 · 提醒', color: COLORS.yellow },
  green: { text: '绿 · 正常', color: COLORS.green },
  unknown: { text: '无到期日', color: COLORS.gray },
}

const KIND_META: Record<string, { text: string; color: string }> = {
  health: { text: '健康证', color: COLORS.purple },
  store: { text: '店铺证照', color: COLORS.blue },
}

const DEFAULT_LEVELS: CertLevel[] = ['expired', 'red', 'orange', 'yellow', 'green', 'unknown']

export default function LicensesPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [data, setData] = useState<FoodsafeCertsResp | null>(null)
  const [thresholds, setThresholds] = useState<CertThresholds | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [level, setLevel] = useState<CertLevel | undefined>(undefined)

  const [certOpen, setCertOpen] = useState(false)
  const [certForm] = Form.useForm()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([fetchFoodsafeCerts(), fetchFoodsafeConfig().catch(() => null)])
      .then(([c, cfg]) => {
        setData(c)
        setThresholds(cfg?.cert ?? c.thresholds ?? null)
        setIsMock(false)
      })
      .catch(() => {
        setData(null)
        setThresholds({ block: 0, red: 7, orange: 14, yellow: 30 })
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const rows = useMemo(() => {
    const all = data?.rows ?? []
    return level ? all.filter((r) => r.level === level) : all
  }, [data, level])

  const cols: ColumnsType<CertRow> = useMemo(
    () => [
      {
        title: '类型',
        key: 'type',
        width: 150,
        render: (_, r) => (
          <Space size={4}>
            <Tag color={KIND_META[r.kind]?.color}>{KIND_META[r.kind]?.text}</Tag>
            <span>{r.type}</span>
          </Space>
        ),
      },
      { title: '持有人/主体', dataIndex: 'holder', width: 160 },
      {
        title: '证号',
        dataIndex: 'cert_no',
        width: 160,
        render: (v) => v ?? <span style={{ color: COLORS.gray }}>-</span>,
      },
      {
        title: '到期日',
        dataIndex: 'expire_at',
        width: 120,
        render: (v) => v ?? <span style={{ color: COLORS.gray }}>-</span>,
      },
      {
        title: '剩余天数',
        key: 'days',
        width: 130,
        sorter: (a, b) => (a.days ?? 9999) - (b.days ?? 9999),
        render: (_, r) => {
          const d = r.days
          const color = LEVEL_META[r.level]?.color ?? COLORS.gray
          if (d == null) return <span style={{ color: COLORS.gray }}>-</span>
          return <Tag color={color}>{d < 0 ? `已过期 ${-d} 天` : `${d} 天`}</Tag>
        },
      },
      {
        title: '分级',
        key: 'level',
        width: 120,
        render: (_, r) => <Tag color={LEVEL_META[r.level]?.color}>{LEVEL_META[r.level]?.text}</Tag>,
      },
      {
        title: '联动',
        key: 'link',
        width: 130,
        render: (_, r) => {
          if (r.blocked) return <Tag color={COLORS.red}>排班禁岗</Tag>
          if (r.store_risk) return <Tag color={COLORS.red}>停业风险</Tag>
          return <span style={{ color: COLORS.gray }}>-</span>
        },
      },
      {
        title: '操作',
        key: 'op',
        width: 90,
        render: (_, r) =>
          canWrite ? (
            <Button
              size="small"
              onClick={() => {
                certForm.resetFields()
                certForm.setFieldsValue({
                  cert_type: r.type,
                  holder: r.holder,
                  cert_no: r.cert_no ?? undefined,
                  id: r.id ?? undefined,
                })
                setCertOpen(true)
              }}
            >
              续期
            </Button>
          ) : (
            <span style={{ color: COLORS.gray }}>只读</span>
          ),
      },
    ],
    [canWrite, certForm],
  )

  const counts = data?.counts ?? {}
  const blocked = data?.health_blocked ?? []

  const submitCert = async () => {
    const v = await certForm.validateFields()
    setBusy(true)
    try {
      const res = await upsertFoodsafeCert({
        id: v.id,
        cert_type: v.cert_type,
        holder: v.holder,
        cert_no: v.cert_no || undefined,
        issued_at: v.issued_at ? (v.issued_at as Dayjs).format('YYYY-MM-DD') : undefined,
        expire_at: (v.expire_at as Dayjs).format('YYYY-MM-DD'),
        status: v.status || '有效',
      })
      if (res.ok) {
        message.success(res.note || '证照已登记，待审批中心确认')
        setCertOpen(false)
        load()
      } else message.error(res.error || '登记失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const submitCfg = async () => {
    const v = await cfgForm.validateFields()
    setBusy(true)
    try {
      const res = await saveFoodsafeConfig({
        block: Number(v.block),
        red: Number(v.red),
        orange: Number(v.orange),
        yellow: Number(v.yellow),
      })
      if (res.ok) {
        setThresholds(res.cert)
        message.success('临期阈值已保存')
        setCfgOpen(false)
        load()
      } else message.error('保存失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端 /api/foodsafe/certs 未连通，当前为本地样例数据"
        />
      )}

      {data?.store_stop_risk && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="停业风险：店铺证照已逾期，已推送老板"
          description={(data.store_risks ?? []).map((r) => `${r.type}（${r.holder}）`).join('、')}
        />
      )}
      {blocked.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`健康证禁岗 ${blocked.length} 人`}
          description={`${blocked.join('、')}（逾期或红级，排班禁岗）`}
        />
      )}

      <Card
        title="证照临期分级台账"
        extra={
          <Space wrap>
            <Select
              allowClear
              placeholder="全部分级"
              style={{ width: 140 }}
              value={level}
              onChange={(v) => setLevel(v)}
              options={DEFAULT_LEVELS.map((l) => ({ value: l, label: LEVEL_META[l].text }))}
            />
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                disabled={!canWrite}
                onClick={() => {
                  cfgForm.setFieldsValue({
                    block: thresholds?.block ?? 0,
                    red: thresholds?.red ?? 7,
                    orange: thresholds?.orange ?? 14,
                    yellow: thresholds?.yellow ?? 30,
                  })
                  setCfgOpen(true)
                }}
              >
                阈值配置
              </Button>
            </Tooltip>
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button
                type="primary"
                disabled={!canWrite}
                onClick={() => {
                  certForm.resetFields()
                  certForm.setFieldsValue({ status: '有效' })
                  setCertOpen(true)
                }}
              >
                证照登记
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="逾期 · 禁营"
                value={counts.expired ?? 0}
                valueStyle={{ color: COLORS.red }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic title="红级" value={counts.red ?? 0} valueStyle={{ color: COLORS.red }} />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="橙级"
                value={counts.orange ?? 0}
                valueStyle={{ color: COLORS.orange }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="黄级"
                value={counts.yellow ?? 0}
                valueStyle={{ color: COLORS.yellow }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="正常"
                value={counts.green ?? 0}
                valueStyle={{ color: COLORS.green }}
              />
            </Card>
          </Col>
          <Col xs={12} md={6} xl={4}>
            <Card size="small">
              <Statistic
                title="禁岗人数"
                value={blocked.length}
                valueStyle={{ color: blocked.length ? COLORS.red : COLORS.green }}
              />
            </Card>
          </Col>
        </Row>

        {thresholds && (
          <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="逾期禁营 ≤">{thresholds.block} 天</Descriptions.Item>
            <Descriptions.Item label="红 ≤">{thresholds.red} 天</Descriptions.Item>
            <Descriptions.Item label="橙 ≤">{thresholds.orange} 天</Descriptions.Item>
            <Descriptions.Item label="黄 ≤">{thresholds.yellow} 天</Descriptions.Item>
          </Descriptions>

        )}

        {(data?.advice ?? []).length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            {(data?.advice ?? []).join('；')}
          </Typography.Paragraph>
        )}

        <Table<CertRow>
          rowKey={(r) => String(r.id ?? `${r.type}-${r.holder}`)}
          columns={cols}
          dataSource={rows}
          loading={loading}
          pagination={{ pageSize: 20 }}
          size="small"
        />
      </Card>

      <Modal
        title="证照登记 / 续期"
        open={certOpen}
        onCancel={() => setCertOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={submitCert}
      >
        <Form form={certForm} layout="vertical" preserve={false}>
          <Form.Item name="id" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="cert_type"
            label="证照类型"
            rules={[{ required: true, message: '请填写证照类型' }]}
          >
            <Input placeholder="如：健康证 / 食品经营许可证" />
          </Form.Item>
          <Form.Item
            name="holder"
            label="持有人 / 主体"
            rules={[{ required: true, message: '请填写持有人' }]}
          >
            <Input placeholder="如：张三 / 熊猫五福餐厅" />
          </Form.Item>
          <Form.Item name="cert_no" label="证号">
            <Input placeholder="选填" />
          </Form.Item>
          <Form.Item name="issued_at" label="签发日">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="expire_at"
            label="到期日"
            rules={[{ required: true, message: '请选择到期日' }]}
          >
            <DatePicker style={{ width: '100%' }} disabledDate={(d) => d.isBefore(dayjs().startOf('day'))} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Input placeholder="默认：有效" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="登记后进入审批中心确认，确认通过才写回店内库。"
          />
        </Form>
      </Modal>

      <Modal
        title="证照临期阈值配置"
        open={cfgOpen}
        onCancel={() => setCfgOpen(false)}
        confirmLoading={busy}
        destroyOnHidden
        onOk={submitCfg}
      >
        <Form form={cfgForm} layout="vertical" preserve={false}>
          <Form.Item
            name="block"
            label="逾期禁营阈值（剩余天数 < 该值为已逾期）"
            rules={[{ required: true, message: '请填写' }]}
          >
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="red" label="红级阈值（天）" rules={[{ required: true, message: '请填写' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="orange" label="橙级阈值（天）" rules={[{ required: true, message: '请填写' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="yellow" label="黄级阈值（天）" rules={[{ required: true, message: '请填写' }]}>
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="需满足：逾期禁营 ≤ 红 ≤ 橙 ≤ 黄；保存即对全店证照分级生效。"
          />
        </Form>
      </Modal>
    </div>
  )
}
