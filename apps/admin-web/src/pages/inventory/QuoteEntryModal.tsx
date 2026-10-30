import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Typography,
  message,
} from 'antd'
import { logSupplyQuote } from '../../api'
import { client } from '../../api/client'
import {
  DEF_COMPARE_PLATFORMS,
  comparePlatformUrl,
  normalizeComparePlatforms,
  type ComparePlatform,
} from './comparePlatforms'

/**
 * 报价录入弹窗（FP-PRICE-04/05/15）
 *
 * 抽成共享组件的原因（ADR-013 W3-04）：供应商比价页与原料库存页都要「录一条外部报价」，
 * 口径必须唯一——归属键用原料 id（`ing`），金额口径按 per（buy=采购单位 / stock=库存单位）
 * 由后端 `quote.upsert` 落库，前端只做实时折算提示。
 *
 * 红线：提交走 `POST /api/supply/quote` → `quote.upsert` 入审批队列，不直写快照。
 */

export type QuoteIngOption = {
  ingId: string
  name: string
  avg: number
  unit: string
  buy?: string
  conv?: number
}

type Props = {
  open: boolean
  ings: QuoteIngOption[]
  /** 预选原料（原料行内「比价」入口用） */
  defaultIngId?: string
  /** 外部平台表；不传则本组件自行拉 `config.compare_platforms`（失败回落旧版默认表） */
  platforms?: ComparePlatform[]
  onCancel: () => void
  /** 提交成功（已入队）后回调；调用方可据此刷新列表 */
  onDone?: () => void
}

export default function QuoteEntryModal({
  open,
  ings,
  defaultIngId,
  platforms,
  onCancel,
  onDone,
}: Props) {
  const [form] = Form.useForm()
  const [busy, setBusy] = useState(false)
  const [localPlatforms, setLocalPlatforms] = useState<ComparePlatform[]>(
    DEF_COMPARE_PLATFORMS.map((p) => ({ ...p })),
  )

  /* 平台表：外部不传时自行拉一次（只读；失败静默回落默认表，不阻塞录价） */
  useEffect(() => {
    if (platforms || !open) return
    client.get<{ config?: { compare_platforms?: unknown } }>('/admin/config')
      .then((r) => {
        const list = normalizeComparePlatforms(r.data?.config?.compare_platforms)
        if (list.length) setLocalPlatforms(list)
      })
      .catch(() => {})
  }, [platforms, open])

  const plats = platforms ?? localPlatforms
  const qIng = Form.useWatch('ing', form)
  const qPrice = Form.useWatch('price', form)
  const qPer = Form.useWatch('per', form)

  const row = useMemo(() => ings.find((r) => r.ingId === qIng) || null, [ings, qIng])

  /* 口径实时折算（与 bff/lib/price.js::quotePerStock 一致：per=buy 时 ÷ conv） */
  const hint = useMemo(() => {
    if (!row) return null
    const p = Number(qPrice) || 0
    if (p <= 0) return null
    const conv = (row.conv ?? 1) > 0 ? Number(row.conv) : 1
    const unit = qPer === 'stock' ? p : p / conv
    const avg = Number(row.avg) || 0
    const diff = unit - avg
    const pct = avg > 0 ? (Math.abs(diff) / avg) * 100 : 0
    return { unit, avg, diff, pct, unitName: row.unit, buy: row.buy || row.unit, conv: Number(row.conv ?? 1) }
  }, [row, qPrice, qPer])

  const submit = async () => {
    const v = await form.validateFields()
    const target = ings.find((r) => r.ingId === v.ing) || null
    setBusy(true)
    try {
      const res = await logSupplyQuote({
        ing: v.ing,
        name: target?.name,
        src: String(v.src || '').trim(),
        price: Number(v.price),
        per: v.per,
        unit: v.unit,
        note: v.note,
        set_default_sup: v.set_default_sup === true,
      })
      if (res.ok) {
        message.success(res.note || '报价已入队')
        onDone?.()
        onCancel()
      } else {
        message.error(res.error || '报价提交失败')
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '报价提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={defaultIngId ? `录入供应商报价 · ${row?.name ?? ''}` : '录入供应商报价'}
      open={open}
      onCancel={onCancel}
      confirmLoading={busy}
      destroyOnHidden
      onOk={submit}
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ ing: defaultIngId, per: 'buy' }}
      >
        <Form.Item name="ing" label="原料" rules={[{ required: true, message: '请选择原料' }]}>
          {/* value 取原料 id：报价据此归集到「原料比价」主表（名称仅作显示与回退匹配） */}
          <Select
            showSearch
            placeholder="选择在售原料"
            options={ings.map((r) => ({
              value: r.ingId,
              label: `${r.name}（本店均价 ¥${r.avg}/${r.unit}）`,
            }))}
            filterOption={(inp, opt) => String(opt?.label ?? '').includes(inp)}
          />
        </Form.Item>
        <Form.Item name="src" label="供应商" rules={[{ required: true, message: '请填写供应商' }]}>
          <Input />
        </Form.Item>
        <Form.Item name="per" label="报价口径" initialValue="buy">
          <Select
            options={[
              {
                value: 'buy',
                label: row && Number(row.conv ?? 1) > 1
                  ? `按采购单位（元/${row.buy || row.unit}，1${row.buy || row.unit}=${row.conv}${row.unit}）`
                  : '按采购单位',
              },
              { value: 'stock', label: row ? `按库存单位（元/${row.unit}）` : '按库存单位' },
            ]}
          />
        </Form.Item>
        <Form.Item name="price" label="报价金额（元）" rules={[{ required: true, message: '请填写报价' }]}>
          <InputNumber style={{ width: '100%' }} min={0} step={0.01} />
        </Form.Item>
        {hint && (
          <Alert
            style={{ marginBottom: 12 }}
            showIcon
            type={hint.diff < -0.01 ? 'success' : hint.diff > 0.01 ? 'warning' : 'info'}
            message={
              `折算 ¥${hint.unit.toFixed(2)}/${hint.unitName}，与本店均价 ¥${hint.avg} 相比：`
              + (hint.diff < -0.01
                ? `低 ¥${(-hint.diff).toFixed(2)}（省 ${hint.pct.toFixed(0)}%）`
                : hint.diff > 0.01
                  ? `高 ¥${hint.diff.toFixed(2)}（贵 ${hint.pct.toFixed(0)}%）`
                  : '基本持平')
            }
          />
        )}
        <Form.Item name="unit" label="单位">
          <Input placeholder="kg / 箱" />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input placeholder="含运 / 到店价" />
        </Form.Item>
        <Form.Item name="set_default_sup" label="设为该原料默认供应商" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>

      {/* FP-PRICE-09：先去外部平台查价，再回来录（旧版 pricePop，HTML:1178-1182） */}
      {row && (
        <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            先去外部平台查「{row.name}」的价：
          </Typography.Text>
          <Space wrap size={4} style={{ marginTop: 6 }}>
            {plats.length
              ? plats.map((p) => (
                  <Button
                    key={p.name || p.tpl}
                    size="small"
                    type="link"
                    href={comparePlatformUrl(p.tpl, row.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {p.name || p.tpl}
                  </Button>
                ))
              : <Typography.Text type="secondary" style={{ fontSize: 12 }}>未配置比价平台（到「设置」添加）</Typography.Text>}
          </Space>
        </div>
      )}
    </Modal>
  )
}
