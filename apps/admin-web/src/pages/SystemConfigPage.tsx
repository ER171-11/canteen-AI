import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Space,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { client } from '../api/client'
import { postAction } from '../api'
import { useAuthStore } from '../store/auth'

type Config = {
  safety_stock?: Record<string, number>
  uniform_sop?: string
  plate_sop?: string
  note?: string
  [k: string]: unknown
}

export default function SystemConfigPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限（配置写仅老板/店长）'
  const [config, setConfig] = useState<Config>({})
  const [source, setSource] = useState<string>('-')
  const [rev, setRev] = useState<string | number | undefined>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  const load = () => {
    setLoading(true)
    client
      .get<{ ok: boolean; config: Config; source?: string; rev?: number }>('/admin/config')
      .then(({ data }) => {
        const c = data.config || {}
        setConfig(c)
        setSource(data.source || '-')
        setRev(data.rev)
        form.setFieldsValue({
          uniform_sop: c.uniform_sop ?? '',
          plate_sop: c.plate_sop ?? '',
          note: c.note ?? '',
          flour_safe: (c.safety_stock as Record<string, number> | undefined)?.['面粉'] ?? 10,
        })
      })
      .catch((e) => message.error(e?.response?.data?.error || '加载配置失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <Card
      title="系统配置"
      loading={loading}
      extra={
        <Space>
          <Typography.Text type="secondary">
            来源 {source} · rev {rev ?? '-'}
          </Typography.Text>
          <Button size="small" onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="配置变更经审批中心入队（config.update），由店内消费器执行后生效，不会直写店内库。"
      />
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 560 }}
        onFinish={async (vals) => {
          setBusy(true)
          try {
            const payload = {
              uniform_sop: vals.uniform_sop,
              plate_sop: vals.plate_sop,
              note: vals.note,
              safety_stock: {
                ...(typeof config.safety_stock === 'object' ? config.safety_stock : {}),
                面粉: vals.flour_safe,
              },
            }
            try {
              /* 优先走 /api/admin/config（服务端 RBAC 更严：仅老板/店长） */
              await client.post('/admin/config', { config: payload })
              message.success('已入队 → 请到审批中心确认执行')
            } catch {
              /* 端点不可用或被拒时回退原 actions 链路 */
              await postAction({
                type: 'config.update',
                payload,
                operator: 'admin',
              })
              message.success('已入队（actions 链路）→ 请到审批中心确认执行')
            }
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '提交失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form.Item name="uniform_sop" label="工服 SOP">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="plate_sop" label="装盘 SOP">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="flour_safe" label="面粉安全库存(kg)">
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input />
        </Form.Item>
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button type="primary" htmlType="submit" loading={busy} disabled={!canWrite}>
            提交配置变更
          </Button>
        </Tooltip>
      </Form>
    </Card>
  )
}
