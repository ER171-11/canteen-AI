import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  DatePicker,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Typography,
  message,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { postAction } from '../../api'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'
import { SALE_PAY_METHODS } from './SalePayModal'

/**
 * FP-SALE-01（admin-web 侧）录入销售单。
 *
 * 执行器 `sale.create` 已在 registry.js 注册（ADR-008/009），本弹窗只负责表单 + 入队：
 *   · 明细行：菜名 + 数量 + 单价，金额 = 数量 × 单价 前端只做展示与前端校验，
 *     真正的口径校验在服务端 `applySaleCreate`（售价合计>0、折扣≤售价、首付≤应收）。
 *   · 应收 = 售价合计 − 折扣；首付 > 0 时记为第一条收款，欠款 = 应收 − 首付（派生不落库）。
 */
export const SALE_CHANNELS = ['堂食', '外卖', '美团外卖', '其他'] as const

export interface SaleLineDraft {
  key: string
  name: string
  qty: number
  price: number
}

let lineSeq = 0
const newLineKey = () => 'ln_' + (++lineSeq) + '_' + Date.now().toString(36)
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export interface SaleCreateModalProps {
  open: boolean
  onClose: () => void
  onQueued?: () => void
}

export default function SaleCreateModal({ open, onClose, onQueued }: SaleCreateModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [date, setDate] = useState<Dayjs>(dayjs())
  const [channel, setChannel] = useState<string>(SALE_CHANNELS[0])
  const [method, setMethod] = useState<string>(SALE_PAY_METHODS[0])
  const [lines, setLines] = useState<SaleLineDraft[]>([])
  const [discount, setDiscount] = useState<number>(0)
  const [paid, setPaid] = useState<number>(0)
  const [note, setNote] = useState<string>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setDate(dayjs())
    setChannel(SALE_CHANNELS[0])
    setMethod(SALE_PAY_METHODS[0])
    setLines([{ key: newLineKey(), name: '', qty: 1, price: 0 }])
    setDiscount(0)
    setPaid(0)
    setNote('')
  }, [open])

  const sub = useMemo(() => r2(lines.reduce((a, l) => a + (l.qty || 0) * (l.price || 0), 0)), [lines])
  const receivable = useMemo(() => r2(sub - discount), [sub, discount])
  const validLines = useMemo(
    () => lines.filter((l) => l.name.trim() && l.qty > 0 && l.price >= 0),
    [lines],
  )

  const invalid =
    validLines.length === 0 ||
    sub <= 0 ||
    discount < 0 ||
    discount > sub + 0.01 ||
    paid < 0 ||
    paid > receivable + 0.01

  const updateLine = (key: string, patch: Partial<SaleLineDraft>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key))
  const addLine = () =>
    setLines((prev) => [...prev, { key: newLineKey(), name: '', qty: 1, price: 0 }])

  const columns = [
    {
      title: '菜品/项目',
      dataIndex: 'name',
      render: (_: unknown, r: SaleLineDraft) => (
        <Input
          value={r.name}
          placeholder="菜名"
          onChange={(e) => updateLine(r.key, { name: e.target.value })}
        />
      ),
    },
    {
      title: '数量',
      dataIndex: 'qty',
      width: 100,
      render: (_: unknown, r: SaleLineDraft) => (
        <InputNumber
          value={r.qty}
          min={0}
          step={1}
          style={{ width: '100%' }}
          onChange={(v) => updateLine(r.key, { qty: Number(v ?? 0) })}
        />
      ),
    },
    {
      title: '单价',
      dataIndex: 'price',
      width: 110,
      render: (_: unknown, r: SaleLineDraft) => (
        <InputNumber
          value={r.price}
          min={0}
          step={0.01}
          style={{ width: '100%' }}
          onChange={(v) => updateLine(r.key, { price: Number(v ?? 0) })}
        />
      ),
    },
    {
      title: '金额',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, r: SaleLineDraft) => r2(r.qty * r.price).toFixed(2),
    },
    {
      title: '',
      width: 56,
      render: (_: unknown, r: SaleLineDraft) => (
        <Typography.Link type="danger" onClick={() => removeLine(r.key)}>
          删除
        </Typography.Link>
      ),
    },
  ]

  const submit = async () => {
    if (invalid) {
      message.warning('请填写有效明细并核对折扣 / 首付')
      return
    }
    setBusy(true)
    try {
      await postAction({
        type: 'sale.create',
        operator: role ?? account ?? 'admin',
        payload: {
          date: date.format('YYYY-MM-DD'),
          channel,
          method,
          lines: validLines.map((l) => ({ name: l.name.trim(), qty: l.qty, price: r2(l.price) })),
          discount: r2(discount),
          paid: r2(paid),
          note,
          source: 'admin-web/dinein/sales',
        },
      })
      message.success('销售单已入队 → 请到审批中心确认')
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
      title="录入销售单"
      open={open}
      onCancel={onClose}
      okText="确认"
      cancelText="取消"
      width={720}
      confirmLoading={busy}
      okButtonProps={{ disabled: invalid }}
      onOk={submit}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space wrap size="middle">
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
            渠道
            <Select
              value={channel}
              style={{ width: 120, marginLeft: 8 }}
              options={SALE_CHANNELS.map((c) => ({ value: c, label: c }))}
              onChange={setChannel}
            />
          </span>
        </Space>

        <div>
          <Space style={{ marginBottom: 8 }}>
            <Typography.Text strong>菜品明细</Typography.Text>
            <Button size="small" onClick={addLine}>
              添加明细
            </Button>
          </Space>
          <Table
            size="small"
            rowKey="key"
            dataSource={lines}
            columns={columns}
            pagination={false}
          />
        </div>

        <Space wrap size="middle">
          <span>
            折扣/抹零
            <InputNumber
              value={discount}
              min={0}
              step={0.01}
              style={{ width: 120, marginLeft: 8 }}
              onChange={(v) => setDiscount(Number(v ?? 0))}
            />
          </span>
          <span>
            首付
            <InputNumber
              value={paid}
              min={0}
              step={0.01}
              style={{ width: 120, marginLeft: 8 }}
              onChange={(v) => setPaid(Number(v ?? 0))}
            />
          </span>
          <span>
            首付方式
            <Select
              value={method}
              style={{ width: 130, marginLeft: 8 }}
              options={SALE_PAY_METHODS.map((m) => ({ value: m, label: m }))}
              onChange={setMethod}
            />
          </span>
        </Space>

        <div>
          备注
          <Input
            value={note}
            style={{ marginLeft: 8, width: 360 }}
            placeholder="选填"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        <div>
          售价合计：<b>¥{sub.toFixed(2)}</b>
          {'\u3000'}折扣：¥{r2(discount).toFixed(2)}
          {'\u3000'}应收：
          <b>¥{receivable.toFixed(2)}</b>
          {'\u3000'}欠：
          <b style={{ color: receivable - paid > 0.005 ? COLORS.red : undefined }}>
            ¥{r2(receivable - paid).toFixed(2)}
          </b>
        </div>

        {invalid && <Alert type="warning" showIcon message="请填写有效明细，并保证折扣 ≤ 售价合计、首付 ≤ 应收" />}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          应收 = 售价合计 − 折扣（服务端口径）；首付 &gt; 0 记为第一条收款，欠款 = 应收 − 首付 实时派生。
          提交后进审批中心，确认后由店内消费器执行。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
