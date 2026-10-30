import { useEffect, useState } from 'react'
import { Alert, Form, InputNumber, Modal, Typography, message } from 'antd'
import { submitIngBatch } from '../../api'

interface Props {
  open: boolean
  /** 勾选的原料 id 列表（整批一个动作，一条队列 = 一次审批） */
  ids: string[]
  names: string[]
  onCancel: () => void
  onDone: () => void
}

/**
 * W3-02 / FP-ING-06 批量设置安全库存线 / 出成率。
 *
 * 只改主数据（safe/safety/yld），不碰库存与均价——存量校准走「校准」弹窗。
 * 空着的项表示「这一项不改」，两项都空则不允许提交。
 */
export default function StockBatchModal({ open, ids, names, onCancel, onDone }: Props) {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ safe: undefined, yld: undefined })
  }, [open, form])

  const submit = async () => {
    const v = await form.validateFields()
    const hasSafe = v.safe !== undefined && v.safe !== null
    const hasYld = v.yld !== undefined && v.yld !== null
    if (!hasSafe && !hasYld) {
      message.warning('安全线 / 出成率 至少填一项')
      return
    }
    if (!ids.length) {
      message.warning('请先勾选原料')
      return
    }
    setBusy(true)
    try {
      const r = await submitIngBatch({
        ids,
        safe: hasSafe ? Number(v.safe) : undefined,
        yld: hasYld ? Math.min(1, Math.max(0.05, Number(v.yld) / 100)) : undefined,
      })
      if (r.error) message.error(r.error)
      else if (r.settled) message.success(`已批量更新 ${ids.length} 个原料`)
      else if (r.confirmed) message.success('已入队，待审批中心确认')
      else message.success('已提交，待确认')
      onDone()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '批量设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`批量设置 · 已选 ${ids.length} 个原料`}
      open={open}
      onCancel={onCancel}
      confirmLoading={busy}
      okText="批量提交"
      onOk={submit}
      destroyOnHidden
      width={520}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="整批一个动作：勾选 N 个原料只产生 1 条队列动作（1 次审批）"
        description="只改「安全线 / 出成率」主数据，不动库存与均价；留空表示该项不改。"
      />
      {names.length ? (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }} ellipsis={{ rows: 2 }}>
          目标原料：{names.join('、')}
        </Typography.Paragraph>
      ) : null}
      <Form form={form} layout="vertical">
        <Form.Item name="safe" label="安全库存线" extra="留空不改；填 0 表示清掉安全线（按日耗×2 兜底）。">
          <InputNumber min={0} step={0.5} style={{ width: '100%' }} placeholder="如 10" />
        </Form.Item>
        <Form.Item name="yld" label="出成率 %" extra="留空不改；范围 5~100（毛料→净料，100 = 无损耗）。">
          <InputNumber min={5} max={100} step={1} style={{ width: '100%' }} placeholder="如 85" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
