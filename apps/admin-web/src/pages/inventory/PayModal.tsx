import { useEffect, useMemo, useState } from 'react'
import { Alert, DatePicker, InputNumber, Modal, Select, Space, Typography, message } from 'antd'
import type { InventoryDoc } from '../../api/types'
import dayjs, { type Dayjs } from 'dayjs'
import { postAction } from '../../api'
import { docDebt, docPaid } from './utils'
import { fmt, r2, today } from './settle/data'
import { useAuthStore } from '../../store/auth'

/**
 * 补付（欠款清收）弹窗，移植自旧版 openGet(:2054-2080) 的采购侧分支。
 *
 * 红线：写操作一律走「建议动作 → /api/actions 队列 → 审批中心确认」，**不直写库**。
 * 服务端算法 applyRecvPay 会再校验一次金额（0 < amt <= 欠款+0.01），前端校验只是体验。
 */
export const PAY_METHODS = [
  '现金/扫码',
  '微信',
  '支付宝',
  '银行转账',
  '平台结算',
  '挂账转销',
] as const

export interface PayModalProps {
  open: boolean
  doc?: InventoryDoc | null
  onClose: () => void
  onQueued?: () => void
}

export default function PayModal({ open, doc, onClose, onQueued }: PayModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [amount, setAmount] = useState<number>(0)
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [method, setMethod] = useState<string>(PAY_METHODS[0])
  const [busy, setBusy] = useState(false)

  const debt = useMemo(() => (doc ? docDebt(doc) : 0), [doc])

  useEffect(() => {
    if (!open) return
    setAmount(doc ? docDebt(doc) : 0)
    setDate(dayjs())
    setMethod(PAY_METHODS[0])
  }, [open, doc])

  if (!doc) return null

  const invalid = !(amount > 0) || amount > debt + 0.01

  const submit = async () => {
    if (invalid) {
      message.warning('金额需在 0 ~ 欠款之间')
      return
    }
    setBusy(true)
    try {
      await postAction({
        type: 'recv.pay',
        operator: role ?? account ?? 'admin',
        payload: {
          recv_id: String(doc.id ?? doc.no ?? ''),
          amount: r2(amount),
          date: date ? date.format('YYYY-MM-DD') : today(),
          method,
          source: 'admin-web/inventory/inbound',
        },
      })
      message.success('补付已入队 → 请到审批中心确认')
      onQueued?.()
      onClose()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="登记付款（补付）"
      open={open}
      onCancel={onClose}
      okText="确认"
      cancelText="取消"
      confirmLoading={busy}
      okButtonProps={{ disabled: invalid }}
      onOk={submit}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <div>
          单据：<b>{doc.no ?? doc.id}</b>（{doc.date}）
        </div>
        <div>
          应付：<b>¥{fmt(Number(doc.payable) || 0)}</b>
          {'\u3000'}已付：¥{fmt(docPaid(doc))}
          {'\u3000'}欠：
          <b style={{ color: '#cf1322' }}>¥{fmt(debt)}</b>
        </div>

        <Space wrap size="middle">
          <span>
            本次付款金额
            <InputNumber
              value={amount}
              min={0}
              step={0.01}
              style={{ width: 140, marginLeft: 8 }}
              onChange={(v) => setAmount(Number(v) || 0)}
            />
          </span>
          <span>
            日期
            <DatePicker
              value={date}
              allowClear={false}
              style={{ marginLeft: 8 }}
              onChange={(d) => d && setDate(d)}
            />
          </span>
          <span>
            方式
            <Select
              value={method}
              style={{ width: 130, marginLeft: 8 }}
              options={PAY_METHODS.map((m) => ({ value: m, label: m }))}
              onChange={setMethod}
            />
          </span>
        </Space>

        {invalid && (
          <Alert type="warning" showIcon message="金额需在 0 ~ 欠款之间" />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          提交后进入审批中心，确认后由店内消费器执行；同一笔重复提交不会重复记账。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
