import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { Dayjs } from 'dayjs'
import {
  fetchEquipmentTemps,
  fetchEquipmentMaintain,
  fetchEquipmentEnergy,
  fetchEquipmentOverview,
  fetchEquipmentConfig,
  saveEquipmentConfig,
  logEquipmentMaintain,
  logEquipmentTemp,
  logEquipmentEnergy,
} from '../../api'
import type {
  EnergyRow,
  EquipmentConfigResp,
  EquipmentEnergyResp,
  EquipmentMaintainResp,
  EquipmentOverviewResp,
  EquipmentTempRow,
  EquipmentTempsResp,
  MaintainPlanRow,
  MaintainRecordRow,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

const TEMP_META: Record<string, { text: string; color: string }> = {
  critical: { text: '严重超温', color: COLORS.red },
  over: { text: '超温', color: COLORS.orange },
  warn: { text: '临界', color: COLORS.yellow },
  ok: { text: '正常', color: COLORS.green },
  unknown: { text: '缺数据', color: COLORS.gray },
}
const MAINTAIN_META: Record<string, { text: string; color: string }> = {
  overdue: { text: '已逾期', color: COLORS.red },
  due_soon: { text: '临期', color: COLORS.yellow },
  ok: { text: '正常', color: COLORS.green },
  unknown: { text: '无记录', color: COLORS.gray },
}

const DEFAULT_CFG: EquipmentConfigResp['equipment'] = {
  temps: { 冷藏: 5, 冷冻: -15, 蔬菜: 8 },
  warn_margin: 0.5,
  over_alert_min: 15,
  maintain_interval_d: 30,
  maintain_due_soon_d: 7,
  energy_budget: 5000,
}

export default function DeviceEnergyPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [temps, setTemps] = useState<EquipmentTempsResp | null>(null)
  const [maintain, setMaintain] = useState<EquipmentMaintainResp | null>(null)
  const [energy, setEnergy] = useState<EquipmentEnergyResp | null>(null)
  const [overview, setOverview] = useState<EquipmentOverviewResp | null>(null)
  const [cfg, setCfg] = useState<EquipmentConfigResp['equipment']>(DEFAULT_CFG)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('temp')

  const [tempOpen, setTempOpen] = useState(false)
  const [tempForm] = Form.useForm()
  const [mtOpen, setMtOpen] = useState(false)
  const [mtForm] = Form.useForm()
  const [enOpen, setEnOpen] = useState(false)
  const [enForm] = Form.useForm()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetchEquipmentTemps(),
      fetchEquipmentMaintain(),
      fetchEquipmentEnergy(),
      fetchEquipmentOverview(),
      fetchEquipmentConfig().catch(() => null),
    ])
      .then(([t, m, e, o, c]) => {
        setTemps(t)
        setMaintain(m)
        setEnergy(e)
        setOverview(o)
        if (c?.equipment) setCfg(c.equipment)
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

  const tempCols: ColumnsType<EquipmentTempRow> = useMemo(
    () => [
      { title: '设备', dataIndex: 'device', width: 150, render: (v) => <strong>{v}</strong> },
      { title: '类型', dataIndex: 'kind', width: 90, render: (v) => <Tag color={COLORS.blue}>{v}</Tag> },
      {
        title: '当前温度℃',
        dataIndex: 'temp',
        width: 120,
        sorter: (a, b) => (a.temp ?? 0) - (b.temp ?? 0),
        render: (v, r) => <span style={{ color: TEMP_META[r.level]?.color, fontWeight: 600 }}>{v == null ? '-' : v}</span>,
      },
      { title: '上限℃', dataIndex: 'max', width: 90 },
      { title: '持续(分)', dataIndex: 'minutes', width: 90, render: (v) => (v ? <Tag color={COLORS.orange}>{v}</Tag> : '-') },
      { title: '分级', key: 'level', width: 110, render: (_, r) => <Tag color={TEMP_META[r.level]?.color}>{TEMP_META[r.level]?.text}</Tag> },
    ],
    [],
  )

  const planCols: ColumnsType<MaintainPlanRow> = useMemo(
    () => [
      { title: '设备', dataIndex: 'device', width: 160, render: (v) => <strong>{v}</strong> },
      { title: '最近维保', dataIndex: 'last_ts', width: 160, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-') },
      { title: '下次到期', dataIndex: 'next_due', width: 130, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD') : '-') },
      {
        title: '剩余天数',
        dataIndex: 'days_left',
        width: 120,
        sorter: (a, b) => (a.days_left ?? 9999) - (b.days_left ?? 9999),
        render: (v) => (v == null ? '-' : v < 0 ? <Tag color={COLORS.red}>逾期 {-v} 天</Tag> : <span>{v} 天</span>),
      },
      { title: '分级', key: 'level', width: 100, render: (_, r) => <Tag color={MAINTAIN_META[r.level]?.color}>{MAINTAIN_META[r.level]?.text}</Tag> },
    ],
    [],
  )

  const mtHistCols: ColumnsType<MaintainRecordRow> = useMemo(
    () => [
      { title: '设备', dataIndex: 'device', width: 140 },
      { title: '类型', dataIndex: 'kind', width: 90, render: (v) => <Tag>{v}</Tag> },
      { title: '操作人', dataIndex: 'operator', width: 100, render: (v) => v ?? '-' },
      { title: '时间', dataIndex: 'ts', width: 160, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '-') },
      { title: '费用', dataIndex: 'cost', width: 90, render: (v) => (v == null ? '-' : `¥${v}`) },
      { title: '备注', dataIndex: 'note', render: (v) => v ?? '-' },
    ],
    [],
  )

  const enCols: ColumnsType<EnergyRow> = useMemo(
    () => [
      { title: '日期', dataIndex: 'date', width: 120, render: (v) => v ?? '-' },
      { title: '设备', dataIndex: 'device', width: 140 },
      { title: '种类', dataIndex: 'kind', width: 80, render: (v) => <Tag color={COLORS.gold}>{v}</Tag> },
      { title: '读数', dataIndex: 'reading', width: 110, render: (v) => (v == null ? '-' : v) },
      { title: '用量', dataIndex: 'usage', width: 110, render: (v) => (v == null ? '-' : v) },
    ],
    [],
  )

  const submitTemp = async () => {
    const v = await tempForm.validateFields()
    setBusy(true)
    try {
      const res = await logEquipmentTemp({ device: v.device, temp: Number(v.temp) })
      if (res.ok) {
        message.success(res.over ? `温度登记已入队（${TEMP_META[res.level || '']?.text || '超温'}预警）` : '温度登记已入队')
        setTempOpen(false)
        load()
      } else message.error(res.error || '登记失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const submitMaintain = async () => {
    const v = await mtForm.validateFields()
    setBusy(true)
    try {
      const res = await logEquipmentMaintain({
        device: v.device,
        kind: v.kind,
        cost: v.cost == null ? undefined : Number(v.cost),
        note: v.note,
      })
      if (res.ok) {
        message.success(res.note || '维保登记已入队 → 审批中心确认')
        setMtOpen(false)
        load()
      } else message.error(res.error || '登记失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '登记失败')
    } finally {
      setBusy(false)
    }
  }

  const submitEnergy = async () => {
    const v = await enForm.validateFields()
    setBusy(true)
    try {
      const res = await logEquipmentEnergy({
        date: v.date ? (v.date as Dayjs).format('YYYY-MM-DD') : undefined,
        device: v.device,
        kind: v.kind,
        reading: v.reading == null ? undefined : Number(v.reading),
        usage: v.usage == null ? undefined : Number(v.usage),
      })
      if (res.ok) {
        message.success(res.note || '能耗抄表已入队 → 审批中心确认')
        setEnOpen(false)
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
      const res = await saveEquipmentConfig({
        temps: { 冷藏: Number(v.冷藏), 冷冻: Number(v.冷冻), 蔬菜: Number(v.蔬菜) },
        warn_margin: Number(v.warn_margin),
        over_alert_min: Number(v.over_alert_min),
        maintain_interval_d: Number(v.maintain_interval_d),
        maintain_due_soon_d: Number(v.maintain_due_soon_d),
        energy_budget: Number(v.energy_budget),
      })
      if (res.ok) {
        setCfg(res.equipment)
        message.success('设备配置已保存')
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

  const openCfg = () => {
    cfgForm.setFieldsValue({
      冷藏: cfg.temps['冷藏'],
      冷冻: cfg.temps['冷冻'],
      蔬菜: cfg.temps['蔬菜'],
      warn_margin: cfg.warn_margin,
      over_alert_min: cfg.over_alert_min,
      maintain_interval_d: cfg.maintain_interval_d,
      maintain_due_soon_d: cfg.maintain_due_soon_d,
      energy_budget: cfg.energy_budget,
    })
    setCfgOpen(true)
  }

  const readOnlyTip = canWrite ? undefined : '当前角色无写权限，仅可查看'
  const maxEnergy = Math.max(...(energy?.items ?? []).map((i) => i.amount), 1)

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端 /api/equipment 未连通，当前为本地样例数据"
        />
      )}

      {(overview?.alerts ?? []).slice(0, 4).map((a, i) => (
        <Alert
          key={i}
          type={a.level === 'red' ? 'error' : a.level === 'orange' ? 'warning' : 'info'}
          showIcon
          style={{ marginBottom: 12 }}
          message={a.text}
        />
      ))}

      <Card
        title="设备温度 · 维保 · 能耗"
        extra={
          <Space wrap>
            <Tooltip title={readOnlyTip}>
              <Button disabled={!canWrite} onClick={openCfg}>
                阈值配置
              </Button>
            </Tooltip>
            <Tooltip title={readOnlyTip}>
              <Button disabled={!canWrite} onClick={() => { tempForm.resetFields(); setTempOpen(true) }}>
                温度登记
              </Button>
            </Tooltip>
            <Tooltip title={readOnlyTip}>
              <Button disabled={!canWrite} onClick={() => { mtForm.resetFields(); mtForm.setFieldsValue({ kind: '保养' }); setMtOpen(true) }}>
                维保登记
              </Button>
            </Tooltip>
            <Tooltip title={readOnlyTip}>
              <Button type="primary" disabled={!canWrite} onClick={() => { enForm.resetFields(); enForm.setFieldsValue({ kind: '电', date: dayjs() }); setEnOpen(true) }}>
                能耗抄表
              </Button>
            </Tooltip>
            <Button size="small" onClick={load}>
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="超温设备" value={overview?.temps.over ?? 0} suffix={`/ ${overview?.temps.total ?? 0}`} valueStyle={{ color: (overview?.temps.over ?? 0) ? COLORS.red : COLORS.green }} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="维保逾期" value={overview?.maintain.counts.overdue ?? 0} valueStyle={{ color: (overview?.maintain.counts.overdue ?? 0) ? COLORS.red : COLORS.green }} />
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="能耗合计" value={overview?.energy.total ?? 0} prefix="¥" valueStyle={{ color: overview?.energy.over_budget ? COLORS.red : COLORS.black }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>预算 ¥{overview?.energy.budget ?? 0}{overview?.energy.ratio != null ? ` · 占营收 ${overview.energy.ratio}%` : ''}</Typography.Text>
            </Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small">
              <Statistic title="维保周期" value={overview?.maintain.interval_d ?? 0} suffix="天" />
            </Card>
          </Col>
        </Row>

        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'temp',
              label: `温度监控（${temps?.rows.length ?? 0}）`,
              children: (
                <>
                  {temps?.rows.length ? (
                    <Table<EquipmentTempRow>
                      rowKey={(r) => r.device}
                      columns={tempCols}
                      dataSource={temps.rows}
                      loading={loading}
                      pagination={false}
                      size="small"
                    />
                  ) : (
                    <Empty description="暂无温度传感器数据" />
                  )}
                  {temps?.limits && (
                    <Descriptions size="small" column={3} style={{ marginTop: 12 }}>
                      <Descriptions.Item label="冷冻上限 ≤">{temps.limits['冷冻']} ℃</Descriptions.Item>
                      <Descriptions.Item label="冷藏上限 ≤">{temps.limits['冷藏']} ℃</Descriptions.Item>
                      <Descriptions.Item label="蔬菜上限 ≤">{temps.limits['蔬菜']} ℃</Descriptions.Item>
                    </Descriptions>
                  )}
                </>
              ),
            },
            {
              key: 'maintain',
              label: `维保计划（${maintain?.devices.length ?? 0}）`,
              children: (
                <>
                  <Table<MaintainPlanRow>
                    rowKey={(r) => r.device}
                    columns={planCols}
                    dataSource={maintain?.devices ?? []}
                    loading={loading}
                    pagination={false}
                    size="small"
                    style={{ marginBottom: 16 }}
                  />
                  <Card size="small" title="维保记录">
                    {(maintain?.rows ?? []).length ? (
                      <Table<MaintainRecordRow>
                        rowKey={(r) => String(r.id ?? `${r.device}-${r.ts}`)}
                        columns={mtHistCols}
                        dataSource={maintain?.rows ?? []}
                        pagination={{ pageSize: 10 }}
                        size="small"
                      />
                    ) : (
                      <Empty description="暂无维保记录" />
                    )}
                  </Card>
                </>
              ),
            },
            {
              key: 'energy',
              label: '能耗监控',
              children: (
                <>
                  <Row gutter={[16, 16]}>
                    <Col xs={24} md={12}>
                      <Card size="small" title={`能耗结构（合计 ¥${energy?.total ?? 0}）`}>
                        {(energy?.items ?? []).map((it) => (
                          <div key={it.kind} style={{ marginBottom: 10 }}>
                            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                              <span>{it.kind}</span>
                              <span>¥{it.amount}</span>
                            </Space>
                            <Progress
                              percent={Math.round((it.amount / maxEnergy) * 100)}
                              showInfo={false}
                              strokeColor={it.kind === '燃气' ? COLORS.orange : it.kind === '水' ? COLORS.blue : COLORS.gold}
                            />
                          </div>
                        ))}
                        {!energy?.items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无能耗数据" />}
                      </Card>
                    </Col>
                    <Col xs={24} md={12}>
                      <Card size="small" title="预算与占比">
                        <Descriptions size="small" column={1}>
                          <Descriptions.Item label="月度预算">¥{energy?.budget ?? 0}</Descriptions.Item>
                          <Descriptions.Item label="本月能耗">¥{energy?.total ?? 0}</Descriptions.Item>
                          <Descriptions.Item label="预算使用率">
                            {energy?.budget ? <Progress percent={Math.min(100, Math.round((energy.total / energy.budget) * 100))} status={energy.over_budget ? 'exception' : 'active'} /> : '-'}
                          </Descriptions.Item>
                          <Descriptions.Item label="占营收比">{energy?.ratio != null ? `${energy.ratio}%` : '（无销售流水）'}</Descriptions.Item>
                        </Descriptions>
                      </Card>
                    </Col>
                  </Row>
                  <Card size="small" title="抄表明细" style={{ marginTop: 16 }}>
                    {(energy?.rows ?? []).length ? (
                      <Table<EnergyRow>
                        rowKey={(r) => String(r.id ?? `${r.device}-${r.date}-${r.kind}`)}
                        columns={enCols}
                        dataSource={energy?.rows ?? []}
                        pagination={{ pageSize: 10 }}
                        size="small"
                      />
                    ) : (
                      <Empty description="暂无抄表记录" />
                    )}
                  </Card>
                </>
              ),
            },
          ]}
        />

        {(overview?.advice ?? []).length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            {overview?.advice.join('；')}
          </Typography.Paragraph>
        )}
      </Card>

      <Modal title="温度登记" open={tempOpen} onCancel={() => setTempOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitTemp}>
        <Form form={tempForm} layout="vertical" preserve={false}>
          <Form.Item name="device" label="设备" rules={[{ required: true, message: '请填写设备' }]}>
            <Input placeholder="如：冷柜 A" />
          </Form.Item>
          <Form.Item name="temp" label="当前温度（℃）" rules={[{ required: true, message: '请填写温度' }]}>
            <InputNumber style={{ width: '100%' }} step={0.1} />
          </Form.Item>
          <Alert type="info" showIcon message="温度属高频时序数据，入队后落本地库（不进 rev）。" />
        </Form>
      </Modal>

      <Modal title="维保登记" open={mtOpen} onCancel={() => setMtOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitMaintain}>
        <Form form={mtForm} layout="vertical" preserve={false}>
          <Form.Item name="device" label="设备" rules={[{ required: true, message: '请填写设备' }]}>
            <Input placeholder="如：冷柜 A" />
          </Form.Item>
          <Form.Item name="kind" label="类型" rules={[{ required: true }]}>
            <Select options={['巡检', '保养', '维修'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="cost" label="费用（元）">
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input placeholder="选填" />
          </Form.Item>
          <Alert type="info" showIcon message="维保登记入队 equipment.maintain，经审批中心确认才写回。" />
        </Form>
      </Modal>

      <Modal title="能耗抄表" open={enOpen} onCancel={() => setEnOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitEnergy}>
        <Form form={enForm} layout="vertical" preserve={false}>
          <Form.Item name="date" label="日期">
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="device" label="设备/表具" rules={[{ required: true, message: '请填写设备' }]}>
            <Input placeholder="如：总表 / 燃气表" />
          </Form.Item>
          <Form.Item name="kind" label="种类" rules={[{ required: true }]}>
            <Select options={['电', '水', '气'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="reading" label="表读数">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="usage" label="用量">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="设备配置" open={cfgOpen} onCancel={() => setCfgOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitCfg}>
        <Form form={cfgForm} layout="vertical" preserve={false}>
          <Form.Item name="冷冻" label="冷冻上限（℃）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="冷藏" label="冷藏上限（℃）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="蔬菜" label="蔬菜上限（℃）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="warn_margin" label="临界余量（℃）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} step={0.1} />
          </Form.Item>
          <Form.Item name="over_alert_min" label="超温升级阈值（分钟）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="maintain_interval_d" label="维保周期（天）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={1} />
          </Form.Item>
          <Form.Item name="maintain_due_soon_d" label="维保临期窗口（天）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Form.Item name="energy_budget" label="月度能耗预算（元）" rules={[{ required: true }]}>
            <InputNumber style={{ width: '100%' }} min={0} />
          </Form.Item>
          <Alert type="info" showIcon message="需满足：维保临期窗口 ≤ 维保周期；保存即对全店设备生效。" />
        </Form>
      </Modal>
    </div>
  )
}
