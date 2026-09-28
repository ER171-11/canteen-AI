import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { client } from '../api/client'
import { fetchSettleTemplate, postAction, saveSettleTemplate } from '../api'
import type { SettleTemplate } from '../api/types'
import { DEFAULT_SETTLE_TPL, normalizeSettleTpl } from './inventory/settle/template'
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

  /* ---- 结算单模板（FP-SET-18/19，与 FP-RECV-06 同一缺口）----
   * 存储位置：bff/data/settle_template.json（独立文件）。
   * 不进业务库、不走审批队列 —— 它只是「只读输出层」的排版配置，不是业务数据。
   */
  const [tpl, setTpl] = useState<SettleTemplate>(DEFAULT_SETTLE_TPL)
  const [tplSource, setTplSource] = useState<string>('-')
  const [tplBusy, setTplBusy] = useState(false)
  const [tplForm] = Form.useForm()

  const fillTplForm = (t: SettleTemplate) => {
    tplForm.setFieldsValue({ ...t, subjects: (t.subjects || []).join('/') })
  }

  const loadTpl = () => {
    fetchSettleTemplate()
      .then((r) => {
        const t = normalizeSettleTpl(r.template)
        setTpl(t)
        setTplSource(r.source || '-')
        fillTplForm(t)
      })
      .catch((e: unknown) => {
        const err = e as { response?: { data?: { error?: string } } }
        message.error(err.response?.data?.error || '加载结算单模板失败')
      })
  }

  useEffect(() => {
    loadTpl()
  }, [])

  const saveTpl = async (vals: Record<string, string>) => {
    setTplBusy(true)
    try {
      const subs = String(vals.subjects || '')
        .split(/[\/、,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const next = normalizeSettleTpl({ ...tpl, ...vals, subjects: subs })
      const r = await saveSettleTemplate(next)
      const t = normalizeSettleTpl(r.template)
      setTpl(t)
      setTplSource('file')
      fillTplForm(t)
      message.success('结算单模板已保存（独立文件，不影响业务数据）')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败（仅老板/店长可改）')
    } finally {
      setTplBusy(false)
    }
  }

  const resetTpl = async () => {
    setTplBusy(true)
    try {
      const r = await saveSettleTemplate(DEFAULT_SETTLE_TPL)
      const t = normalizeSettleTpl(r.template)
      setTpl(t)
      setTplSource('default')
      fillTplForm(t)
      message.success('已恢复默认模板（不影响采购单/库存等业务数据）')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '恢复默认失败')
    } finally {
      setTplBusy(false)
    }
  }

  return (
    <div>
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

    <Card
      title="结算单模板"
      style={{ marginTop: 16 }}
      extra={
        <Space>
          <Typography.Text type="secondary">来源 {tplSource}</Typography.Text>
          <Button size="small" onClick={loadTpl}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="结算单是只读输出层。模板存于服务端独立文件（bff/data/settle_template.json），不进业务库、不走审批队列；保存即刻生效，恢复默认也不会动采购单/库存等业务数据。"
      />
      <Form form={tplForm} layout="vertical" style={{ maxWidth: 560 }} onFinish={saveTpl}>
        <Form.Item name="title" label="单据标题">
          <Input placeholder="进货付款审批单" />
        </Form.Item>
        <Form.Item name="restName" label="抬头单位名称">
          <Input placeholder="留空则回落餐厅名" />
        </Form.Item>
        <Form.Item name="addr" label="地址">
          <Input />
        </Form.Item>
        <Form.Item name="tel" label="电话">
          <Input />
        </Form.Item>
        <Form.Item name="taxNo" label="税号">
          <Input />
        </Form.Item>
        <Form.Item name="usePurpose" label="支出用途（默认）">
          <Input placeholder="采购货款" />
        </Form.Item>
        <Form.Item name="payeeName" label="收款单位">
          <Input />
        </Form.Item>
        <Form.Item name="payeeBank" label="开户行">
          <Input />
        </Form.Item>
        <Form.Item name="payeeAccount" label="银行账号">
          <Input />
        </Form.Item>
        <Form.Item
          name="subjects"
          label="签字栏"
          tooltip="用 / 、 , ，任一分隔，如 经办人/审核人/审批人"
        >
          <Input placeholder="经办人/审核人/审批人" />
        </Form.Item>
        <Form.Item name="footer" label="页脚">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Space>
          <Tooltip title={canWrite ? undefined : noWriteTip}>
            <Button type="primary" htmlType="submit" loading={tplBusy} disabled={!canWrite}>
              保存模板
            </Button>
          </Tooltip>
          <Popconfirm
            title="恢复默认结算单模板？（不影响采购单/库存等业务数据）"
            onConfirm={resetTpl}
            okText="恢复"
            cancelText="取消"
          >
            <Button disabled={!canWrite} loading={tplBusy}>
              恢复默认
            </Button>
          </Popconfirm>
        </Space>
      </Form>
    </Card>
    </div>
  )
}
