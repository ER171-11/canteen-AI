import { useEffect, useMemo, useState } from 'react'
import { Alert, Descriptions, Form, Input, InputNumber, Modal, Typography, message } from 'antd'
import { submitStockCalibrate } from '../../api'
import { fmtNum } from './utils'

/** 校准目标：只要「存量」相关字段，与主数据编辑表单彻底分开（ADR-013 D3） */
export interface CalibrateTarget {
  id: string
  name: string
  unit?: string
  stock?: number
  qty?: number
  avg?: number
}

interface Props {
  open: boolean
  ing: CalibrateTarget | null
  onCancel: () => void
  /** 提交结束（不论成功失败都刷一次列表，让用户看到最新账面） */
  onDone: () => void
}

/**
 * W3-01 / FP-ING-05 手工校准弹窗（ADR-013 D3）。
 *
 * 口径：
 *   · 库存、均价都改 → stock.count 同时带 real_qty + avg；
 *   · 只改均价 → 只带 avg（后端按当前库存落绝对值，数量不动）；
 *   · 只改库存 → 只带 real_qty（均价按原料现有均价保留，不再被清 0）；
 *   · 原因必填 → 写入「手工调整」流水 note，供损耗/审计追溯。
 * 红线：不通过 ing.upsert 改 stock/avg（会被 rebuildStock 冲回）。
 */
export default function StockCalibrateModal({ open, ing, onCancel, onDone }: Props) {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)

  const curQty = Number(ing?.qty ?? ing?.stock ?? 0)
  const curAvg = Number(ing?.avg ?? 0)

  useEffect(() => {
    if (!open) return
    form.setFieldsValue({ qty: curQty, avg: curAvg, note: '' })
  }, [open, curQty, curAvg, form])

  const qtyV = Form.useWatch('qty', form)
  const avgV = Form.useWatch('avg', form)

  const preview = useMemo(() => {
    const q = Number(qtyV ?? 0)
    const a = Number(avgV ?? 0)
    const before = curQty * curAvg
    const after = (Number.isFinite(q) ? q : 0) * (Number.isFinite(a) ? a : 0)
    return { before, after, delta: after - before }
  }, [qtyV, avgV, curQty, curAvg])

  const unit = ing?.unit || '单位'

  const submit = async () => {
    if (!ing) return
    const v = await form.validateFields()
    const note = String(v.note ?? '').trim()
    const nextQty = Number(v.qty)
    const nextAvg = Number(v.avg)
    const qtyChanged = Number.isFinite(nextQty) && Math.abs(nextQty - curQty) > 1e-9
    const avgChanged = Number.isFinite(nextAvg) && Math.abs(nextAvg - curAvg) > 1e-9
    if (!qtyChanged && !avgChanged) {
      message.warning('库存与均价都没有变化，无需校准')
      return
    }
    const payload: {
      ing_id: string
      name?: string
      book_qty?: number
      real_qty?: number
      avg?: number
      note: string
    } = { ing_id: ing.id, name: ing.name, note }
    if (qtyChanged) {
      payload.book_qty = curQty
      payload.real_qty = nextQty
    }
    if (avgChanged) payload.avg = nextAvg

    setBusy(true)
    try {
      const r = await submitStockCalibrate(payload)
      if (r.error) message.error(r.error)
      else if (r.settled) message.success('校准完成（台账已记「手工调整」流水）')
      else if (r.confirmed) message.success('已入队，待审批中心确认')
      else message.success('已提交，待确认')
      onDone()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '校准失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={ing ? `手工校准 · ${ing.name}` : '手工校准'}
      open={open}
      onCancel={onCancel}
      confirmLoading={busy}
      okText="提交校准"
      onOk={submit}
      destroyOnHidden
      width={560}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="校准只改「存量」，不动原料档案"
        description="提交后写入一条「手工调整」流水（数量取校准后绝对值、均价取校准后均价），后续进货按移动加权继续滚动，不会被冲回。分类/供应商/包规等主数据请走「编辑」。"
      />
      <Descriptions size="small" column={2} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="当前库存">{`${fmtNum(curQty)} ${unit}`}</Descriptions.Item>
        <Descriptions.Item label="当前均价">{`${fmtNum(curAvg)} 元/${unit}`}</Descriptions.Item>
        <Descriptions.Item label="当前库存总值" span={2}>{`${fmtNum(preview.before)} 元`}</Descriptions.Item>
      </Descriptions>
      <Form form={form} layout="vertical">
        <Form.Item
          name="qty"
          label={`校准后库存（${unit}）`}
          rules={[{ required: true, message: '请填写校准后库存' }]}
        >
          <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="avg"
          label={`校准后均价（元/${unit}）`}
          extra="可单独改均价：库存数量按当前账面落账，数量不变。"
          rules={[{ required: true, message: '请填写校准后均价' }]}
        >
          <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="note"
          label="校准原因（必填，写入流水）"
          rules={[{ required: true, message: '手工校准必须填写原因' }]}
        >
          <Input.TextArea rows={2} placeholder="如：供应商调价后重算 / 月末盘亏核对 / 退货冲减" maxLength={120} showCount />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        校准后库存总值 {fmtNum(preview.after)} 元（
        {preview.delta >= 0 ? '+' : ''}
        {fmtNum(preview.delta)} 元）
      </Typography.Text>
    </Modal>
  )
}
