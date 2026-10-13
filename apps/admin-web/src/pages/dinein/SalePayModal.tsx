import { useEffect, useMemo, useState } from 'react'
import { Alert, DatePicker, InputNumber, Modal, Select, Space, Typography, message } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { postAction } from '../../api'
import type { SaleListItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'

/**
 * FP-SALE-11 分次收款弹窗（登记后续收款，应收 − 实收 = 欠款）。
 *
 * 移植自旧版 openGet(:2055) 的销售侧分支，与采购侧 PayModal（recv.pay）同型：
 *   红线①：写操作一律走「建议动作 → /api/actions 队列 → 审批中心确认」，**不直写库**。
 *   红线②：欠款是派生值——本弹窗只登记「本次收款金额」，
 *           service 端 `sale.pay` 只向 `payments[]` 追加一条，不动 `receivable`。
 * 服务端算法 applySalePay 会再校验一次（0 < amt <= 欠款+0.01，且已作废单不可收款），
 * 前端校验只是体验，不作为口径来源。
 */
export const SALE_PAY_METHODS = [
  '现金/扫码',
  '微信',
  '支付宝',
  '银行转账',
  '平台结算',
  '挂账转销',
] as const

export interface SalePayModalProps {
  open: boolean
  sale?: SaleListItem | null
  onClose: () => void
  onQueued?: () => void
}

function fmt(n?: number | null): string {
  if (n == null || !isFinite(Number(n))) return '0.00'
  return Number(n).toFixed(2)
}

export default function SalePayModal({ open, sale, onClose, onQueued }: SalePayModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [amount, setAmount] = useState<number>(0)
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [method, setMethod] = useState<string>(SALE_PAY_METHODS[0])
  const [busy, setBusy] = useState(false)

  /** 欠款由后端下发（派生值），前端只读不回算 */
  const debt = useMemo(() => (sale ? Number(sale.debt) || 0 : 0), [sale])

  useEffect(() => {
    if (!open) return
    setAmount(sale ? Number(sale.debt) || 0 : 0)
    setDate(dayjs())
    setMethod(SALE_PAY_METHODS[0])
  }, [open, sale])

  if (!sale) return null

  const invalid = !(amount > 0) || amount > debt + 0.01

  const submit = async () => {
    if (invalid) {
      message.warning('金额需在 0 ~ 欠款之间')
      return
    }
    setBusy(true)
    try {
      await postAction({
        type: 'sale.pay',
        operator: role ?? account ?? 'admin',
        payload: {
          sale_id: String(sale.no ?? sale.id ?? ''),
          amount: Math.round(amount * 100) / 100,
          date: date ? date.format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
          method,
          source: 'admin-web/dinein/sales',
        },
      })
      message.success('收款已入队 → 请到审批中心确认')
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
      title="登记收款（分次收款）"
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
          单据：<b>{sale.no ?? sale.id}</b>（{sale.date}）
        </div>
        <div>
          应收：<b>¥{fmt(sale.receivable)}</b>
          {'\u3000'}已收：¥{fmt(sale.received)}
          {'\u3000'}欠：
          <b style={{ color: COLORS.red }}>¥{fmt(debt)}</b>
        </div>

        <Space wrap size="middle">
          <span>
            本次收款金额
            <InputNumber
              value={amount}
              min={0}
              step={0.01}
              style={{ width: 140, marginLeft: 8 }}
              onChange={(v) => setAmount(Number(v) || 0)}
            />
          </span>
          <span>
            收款日期
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
              options={SALE_PAY_METHODS.map((m) => ({ value: m, label: m }))}
              onChange={setMethod}
            />
          </span>
        </Space>

        {invalid && <Alert type="warning" showIcon message="金额需在 0 ~ 欠款之间" />}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          实收按「收款日期」归属，欠款 = 应收 − Σ收款 实时派生（不落库）；提交后进审批中心，
          确认后由店内消费器执行，同一笔重复提交不会重复记账。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
