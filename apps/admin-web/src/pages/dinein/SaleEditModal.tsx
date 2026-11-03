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
import type { SaleListItem } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { COLORS } from '../../theme'
import { SALE_CHANNELS, type SaleLineDraft } from './SaleCreateModal'
import { SALE_PAY_METHODS } from './SalePayModal'

/**
 * FP-SALE-12 编辑销售单（走「编辑建议动作」入队 → 审批 → sale.update 执行）。
 *
 * 口径与录入一致：应收 = 售价合计 − 折扣（服务端 `applySaleUpdate` 重算）。
 * 销售域关键约束：**应收不得小于累计实收**（否则欠款为负）；本弹窗只改明细/折扣/日期/渠道/备注，
 * 不改 payments（已收款只增不改），欠款 = 应收 − Σ收款 实时派生。
 */
let lineSeq = 0
const newLineKey = () => 'ed_' + (++lineSeq) + '_' + Date.now().toString(36)
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export interface SaleEditModalProps {
  open: boolean
  sale?: SaleListItem | null
  onClose: () => void
  onQueued?: () => void
}

export default function SaleEditModal({ open, sale, onClose, onQueued }: SaleEditModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)

  const [date, setDate] = useState<Dayjs>(dayjs())
  const [channel, setChannel] = useState<string>(SALE_CHANNELS[0])
  const [method, setMethod] = useState<string>(SALE_PAY_METHODS[0])
  const [lines, setLines] = useState<SaleLineDraft[]>([])
  const [discount, setDiscount] = useState<number>(0)
  const [note, setNote] = useState<string>('')
  const [busy, setBusy] = useState(false)

  const received = useMemo(() => (sale ? Number(sale.received) || 0 : 0), [sale])

  useEffect(() => {
    if (!open || !sale) return
    setDate(sale.date ? dayjs(sale.date) : dayjs())
    setChannel(sale.channel || SALE_CHANNELS[0])
    setMethod(sale.method || SALE_PAY_METHODS[0])
    setDiscount(Number(sale.discount) || 0)
    setNote(sale.note || '')
    // 有明细行 → 逐行初始化；无明细（历史数据）→ 回退单行（name = dish 摘要，金额 = 售价合计）
    if (sale.lines && sale.lines.length) {
      setLines(
        sale.lines.map((l) => ({
          key: newLineKey(),
          name: l.name || '',
          qty: l.qty ?? 1,
          price: l.price ?? (l.amount != null && l.qty ? Number(l.amount) / Number(l.qty) : 0),
        })),
      )
    } else {
      setLines([
        {
          key: newLineKey(),
          name: sale.detail || sale.no || '销售单',
          qty: 1,
          price: Number(sale.sub) || 0,
        },
      ])
    }
  }, [open, sale])

  /* Hooks 必须无条件执行：原先这 3 个 useMemo 写在 `if (!sale) return null` 之后，
   * 等于「sale 为空就不调用」，违反 rules-of-hooks（CI ESLint 红灯）。全部上提到早退之前。 */
  const sub = useMemo(() => r2(lines.reduce((a, l) => a + (l.qty || 0) * (l.price || 0), 0)), [lines])
  const receivable = useMemo(() => r2(sub - discount), [sub, discount])
  const validLines = useMemo(
    () => lines.filter((l) => l.name.trim() && l.qty > 0 && l.price >= 0),
    [lines],
  )

  if (!sale) return null

  const invalid =
    validLines.length === 0 ||
    sub <= 0 ||
    discount < 0 ||
    discount > sub + 0.01 ||
    receivable < received - 0.01

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
      message.warning('请核对明细/折扣：应收不得小于已收款')
      return
    }
    setBusy(true)
    try {
      await postAction({
        type: 'sale.update',
        operator: role ?? account ?? 'admin',
        payload: {
          sale_id: String(sale.no ?? sale.id ?? ''),
          date: date.format('YYYY-MM-DD'),
          channel,
          method,
          lines: validLines.map((l) => ({ name: l.name.trim(), qty: l.qty, price: r2(l.price) })),
          discount: r2(discount),
          note,
          source: 'admin-web/dinein/sales',
        },
      })
      message.success('编辑已入队 → 请到审批中心确认')
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
      title={`编辑销售单 · ${sale.no ?? sale.id}`}
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
          <span>
            收款方式
            <Select
              value={method}
              style={{ width: 130, marginLeft: 8 }}
              options={SALE_PAY_METHODS.map((m) => ({ value: m, label: m }))}
              onChange={setMethod}
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
            备注
            <Input
              value={note}
              style={{ marginLeft: 8, width: 240 }}
              placeholder="选填"
              onChange={(e) => setNote(e.target.value)}
            />
          </span>
        </Space>

        <div>
          售价合计：<b>¥{sub.toFixed(2)}</b>
          {'\u3000'}折扣：¥{r2(discount).toFixed(2)}
          {'\u3000'}应收：
          <b>¥{receivable.toFixed(2)}</b>
          {'\u3000'}已收：¥{r2(received).toFixed(2)}
          {'\u3000'}欠：
          <b style={{ color: receivable - received > 0.005 ? COLORS.red : undefined }}>
            ¥{r2(receivable - received).toFixed(2)}
          </b>
        </div>

        {invalid && (
          <Alert
            type="warning"
            showIcon
            message={
              receivable < received - 0.01
                ? `应收 ¥${receivable.toFixed(2)} 小于已收款 ¥${received.toFixed(2)}，请调整明细/折扣`
                : '请填写有效明细，并保证折扣 ≤ 售价合计、应收 ≥ 已收款'
            }
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          已收款只增不改（欠款 = 应收 − Σ收款 派生）；编辑不改变单号与收款记录，提交后进审批中心。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
