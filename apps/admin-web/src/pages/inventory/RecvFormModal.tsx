import { useEffect, useMemo } from 'react'
import {
  Alert,
  AutoComplete,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Typography,
  message,
} from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { postAction } from '../../api'
import type { IngItem, InventoryDoc } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { fmt, r2, today } from './settle/data'

/**
 * 新建 / 编辑 JH 进货单，逐字段移植旧版 openRecv / openDocForm（旧 HTML:1559-1661）。
 *
 * 红线：不直写库——只向 /api/actions 投一条 `recv.inbound`（新建）或 `recv.update`（编辑），
 *   确认由审批中心 + 店内消费器完成。执行器 applyRecvInbound / applyRecvUpdate 已存在，本页不新增写通道。
 *   实付/付款方式/关联采购单/实收量 是 Node 侧对 Python 版做的**向后兼容超集**
 *   （见 bff/lib/algorithms/recv_inbound.test.js / recv_update.test.js 头注）。
 *
 * 编辑模式（editDoc 非空）：预填原单、提交 `recv.update`；已作废单不可编辑（由列表按钮禁用保证）。
 *
 * 与旧版的**已知差异**（都写在界面上，不静默）：
 *   1. 实收量旧版无此输入（只有「数量」一列）；本版拆成 订购量(计价/入库) + 实收量(仅登记)，
 *      定额领用/短收对账属后续阶段。
 *   2. 旧版超付会静默截断到应付；本版超付直接拒绝，避免吞掉多付金额。
 *   3. 关联采购单在旧版由 syncAllOrderRecv() 回写采购单收货进度，Node 侧尚未实现（采购管理页欠账），
 *      本版只登记单向关联。
 *   4. 原料档案未存换算系数 conv，故不显示旧版的「折库存单位」列；本版也不代建新原料
 *      （旧版 openNewIngForPo 属原料档案页）。
 *   5. 编辑时「实付」仅覆盖**初始**付款，历史补付（recv.pay）记录保留（Node 超集保护，旧版无补付概念）。
 */

/** 旧版 openRecv 付款方式 5 项（HTML:1583，顺序与默认值照抄，勿改） */
export const RECV_METHODS = ['现金/转账', '微信', '支付宝', '银行转账', '部分挂账'] as const

interface LineRow {
  ing_id?: string
  qty?: number
  recvQty?: number
  price?: number
}

interface FormVals {
  date: Dayjs
  supplier: string
  po?: string
  note?: string
  method: string
  paid?: number
  items?: LineRow[]
}

export interface RecvFormModalProps {
  open: boolean
  /** 非空 = 编辑模式（预填该单并提交 recv.update）；空 = 新建（提交 recv.inbound） */
  editDoc?: InventoryDoc | null
  ings: IngItem[]
  suppliers: string[]
  orders: InventoryDoc[]
  onClose: () => void
  onQueued?: () => void
}

export default function RecvFormModal({
  open,
  editDoc,
  ings,
  suppliers,
  orders,
  onClose,
  onQueued,
}: RecvFormModalProps) {
  const isEdit = !!(editDoc && (editDoc.id || editDoc.no))
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [form] = Form.useForm<FormVals>()
  const watchedRows = Form.useWatch('items', form) as LineRow[] | undefined
  const rows = useMemo(() => watchedRows ?? [], [watchedRows])
  const paidWatch = Form.useWatch('paid', form) as number | undefined

  const ingById = useMemo(() => {
    const m = new Map<string, IngItem>()
    for (const g of ings) m.set(String(g.id), g)
    return m
  }, [ings])

  /* 旧版 openRecv 打开时：日期=今天、付款方式=首项、明细首行=第一个原料（HTML:1563/1583/1626）；
     编辑模式预填原单（HTML:1642-1654 同字段） */
  useEffect(() => {
    if (!open) return
    form.resetFields()
    if (isEdit && editDoc) {
      form.setFieldsValue({
        date: editDoc.date ? dayjs(String(editDoc.date)) : dayjs(),
        supplier: editDoc.supplier || '',
        po: editDoc.po || undefined,
        note: editDoc.note || '',
        method: editDoc.method || RECV_METHODS[0],
        /* 编辑预填「实付」= 初始付款合计（排除带 source/ts 的补付记录，避免覆盖历史补付） */
        paid: Math.round(
          (editDoc.payments ?? [])
            .filter(
              (p) =>
                !(p && (p as Record<string, unknown>).source) &&
                !(p && (p as Record<string, unknown>).ts),
            )
            .reduce((a, p) => a + (Number(p?.amount) || 0), 0) * 100,
        ) / 100,
        items: (editDoc.lines ?? []).map((l) => ({
          ing_id: String(l.ing ?? ''),
          qty: Number(l.qty) || 0,
          recvQty: l.recvQty == null ? undefined : Number(l.recvQty),
          price: Number(l.price) || 0,
        })),
      })
      return
    }
    const first = ings[0]
    form.setFieldsValue({
      date: dayjs(),
      method: RECV_METHODS[0],
      paid: 0,
      items: first
        ? [{ ing_id: String(first.id), qty: 1, price: Number(first.avg) || 0 }]
        : [{ qty: 1 }],
    })
  }, [open, ings, form, isEdit, editDoc])

  const payable = useMemo(
    () =>
      r2(
        rows.reduce((a, r) => a + (Number(r?.qty) || 0) * (Number(r?.price) || 0), 0),
      ),
    [rows],
  )
  const paid = r2(Number(paidWatch) || 0)
  const debt = r2(Math.max(0, payable - paid))

  const poOptions = useMemo(
    () =>
      orders
        .filter((o) => !['已作废', 'void'].includes(String(o.status ?? '')))
        .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
        .map((o) => ({
          value: String(o.id ?? o.no ?? ''),
          label: `${o.no ?? o.id ?? ''} · ${o.date ?? ''} · ${o.supplier ?? ''}`,
        })),
    [orders],
  )

  const ingOptions = useMemo(
    () =>
      ings.map((g) => ({
        value: String(g.id),
        label: `${g.name}${g.buy || g.unit ? `（${g.buy || g.unit}）` : ''}`,
      })),
    [ings],
  )

  const invalid = !(payable > 0) || paid > payable + 0.01

  const submit = async () => {
    const v = await form.validateFields()
    const list = (v.items ?? []).filter((r) => r && r.ing_id)
    if (!list.length) {
      message.warning('请至少填写一行明细（原料 + 订购量）')
      return
    }
    const sum = r2(
      list.reduce((a, r) => a + (Number(r.qty) || 0) * (Number(r.price) || 0), 0),
    )
    if (!(sum > 0)) {
      message.warning('应付合计需大于 0，请检查订购量/单价')
      return
    }
    const pay = r2(Number(v.paid) || 0)
    if (pay > sum + 0.01) {
      message.warning('实付不得超过应付合计（超付会被执行器拒绝）')
      return
    }
    try {
      await postAction({
        type: isEdit ? 'recv.update' : 'recv.inbound',
        operator: role ?? account ?? 'admin',
        payload: {
          /* 编辑模式：带 id 让执行器 applyRecvUpdate 定位原单；新建不带 id */
          ...(isEdit ? { id: String(editDoc?.id ?? editDoc?.no ?? '') } : {}),
          supplier: String(v.supplier).trim(),
          date: v.date ? v.date.format('YYYY-MM-DD') : today(),
          note: v.note?.trim() || undefined,
          method: v.method,
          paid: pay,
          /* 只登记单向关联：不要用 po_id —— 执行器把 po_id 当「自采购单建单」入口（别名 order_id） */
          po: v.po || undefined,
          items: list.map((r) => ({
            ing_id: r.ing_id,
            name: ingById.get(String(r.ing_id))?.name,
            qty: Number(r.qty) || 0,
            price: Number(r.price) || 0,
            ...(r.recvQty == null ? {} : { recvQty: Number(r.recvQty) }),
          })),
          source: 'admin-web/inventory/inbound',
        },
      })
      message.success(
        isEdit
          ? '进货单修改已入队 → 请到审批中心确认（确认后店内库存/欠款才变）'
          : '进货单已入队 → 请到审批中心确认（确认后店内库存/欠款才变）',
      )
      onQueued?.()
      onClose()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    }
  }

  const headCell = (text: string, width: number, align: 'left' | 'right' = 'left') => (
    <div style={{ width, textAlign: align, fontSize: 12, color: '#8c8c8c' }}>{text}</div>
  )

  return (
    <Modal
      title={isEdit ? `编辑 JH 进货单 · ${editDoc?.no ?? editDoc?.id ?? ''}` : '新建 JH 进货单'}
      open={open}
      width={900}
      onCancel={onClose}
      okText={isEdit ? '提交修改' : '提交入队'}
      cancelText="取消"
      okButtonProps={{ disabled: invalid }}
      onOk={submit}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Space size="middle" wrap style={{ display: 'flex' }}>
          <Form.Item label="日期" name="date" rules={[{ required: true, message: '请选日期' }]}>
            <DatePicker allowClear={false} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item
            label="供应商"
            name="supplier"
            rules={[
              {
                required: true,
                whitespace: true,
                message: '请填写供应商（旧版必填，否则拒绝保存）',
              },
            ]}
            style={{ width: 220 }}
          >
            <AutoComplete
              options={suppliers.map((s) => ({ value: s }))}
              placeholder="供应商名称"
              filterOption={(input, opt) =>
                String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
          <Form.Item label="关联采购单（可不选）" name="po" style={{ width: 300 }}>
            <Select
              allowClear
              placeholder="不关联"
              options={poOptions}
              showSearch
              optionFilterProp="label"
              notFoundContent="暂无采购单"
            />
          </Form.Item>
        </Space>

        <Form.Item label="备注" name="note">
          <Input placeholder="如：早市到货 / 冷链" />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          明细（数量/单价均按采购单位）
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}>
          {headCell('原料', 240)}
          {headCell('订购量', 100, 'right')}
          {headCell('实收量', 100, 'right')}
          {headCell('单价(元)', 110, 'right')}
          {headCell('金额', 100, 'right')}
          {headCell('操作', 60, 'right')}
        </div>

        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => (
                <Space key={field.key} align="baseline" size={8}>
                  <Form.Item
                    name={[field.name, 'ing_id']}
                    rules={[{ required: true, message: '请选择原料（或删除该空行）' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <Select
                      showSearch
                      style={{ width: 240 }}
                      placeholder="原料"
                      options={ingOptions}
                      optionFilterProp="label"
                      onChange={(id: string) => {
                        const g = ingById.get(String(id))
                        const list = [...(form.getFieldValue('items') ?? [])]
                        list[field.name] = {
                          ...list[field.name],
                          ing_id: id,
                          price: Number(g?.avg) || 0,
                        }
                        form.setFieldsValue({ items: list })
                      }}
                    />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'qty']}
                    rules={[{ required: true, message: '订购量' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber min={0} step={1} style={{ width: 100 }} placeholder="订购量" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'recvQty']}
                    rules={[
                      {
                        validator: (_r, value) =>
                          value == null || Number(value) > 0
                            ? Promise.resolve()
                            : Promise.reject(new Error('实收量需 > 0，未收到请删行')),
                      },
                    ]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber min={0} step={1} style={{ width: 100 }} placeholder="实收量" />
                  </Form.Item>
                  <Form.Item
                    name={[field.name, 'price']}
                    rules={[{ required: true, message: '单价' }]}
                    style={{ marginBottom: 8 }}
                  >
                    <InputNumber min={0} step={0.01} style={{ width: 110 }} placeholder="单价" />
                  </Form.Item>
                  <div style={{ width: 100, textAlign: 'right', paddingTop: 4 }}>
                    ¥{fmt((Number(rows[field.name]?.qty) || 0) * (Number(rows[field.name]?.price) || 0))}
                  </div>
                  <Button type="link" size="small" style={{ width: 60 }} onClick={() => remove(field.name)}>
                    删
                  </Button>
                </Space>
              ))}
              <Button
                style={{ marginTop: 4 }}
                onClick={() => add({ qty: 1, price: Number(ings[0]?.avg) || 0 })}
              >
                ＋ 添加原料
              </Button>
            </>
          )}
        </Form.List>

        <div style={{ marginTop: 8 }}>
          应付合计：<b>¥{fmt(payable)}</b>
        </div>

        <Typography.Title level={5} style={{ marginTop: 16 }}>
          本次付款
        </Typography.Title>
        <Space size="middle" wrap style={{ display: 'flex' }}>
          <Form.Item label="实付金额（元，欠款可后续补付）" name="paid" style={{ marginBottom: 4 }}>
            <InputNumber min={0} step={0.01} style={{ width: 160 }} />
          </Form.Item>
          <Button style={{ marginTop: 26 }} onClick={() => form.setFieldsValue({ paid: payable })}>
            按应付全额
          </Button>
          <Form.Item label="付款方式" name="method" style={{ marginBottom: 4 }}>
            <Select
              style={{ width: 140 }}
              options={RECV_METHODS.map((m) => ({ value: m, label: m }))}
            />
          </Form.Item>
          <div style={{ marginTop: 26 }}>
            欠款：
            <b style={{ color: debt > 0.01 ? '#cf1322' : '#389e0d' }}>¥{fmt(debt)}</b>
          </div>
        </Space>

        {invalid ? (
          <Alert type="warning" showIcon message="应付合计需大于 0，且实付不得超过应付" />
        ) : null}

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 8 }}
          message="提交后进入审批中心，确认后由店内消费器执行（rebuildStock 重算库存与欠款）"
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本版已知差异：① 实收量仅登记展示，库存/应付仍按订购量计算（旧版只有「数量」一列）；
              ② 实付超过应付会被拒绝（不学旧版的静默截断）；③ 关联采购单只登记单向关联，
              采购单「收货进度」回写（旧版 syncAllOrderRecv）尚未实现；④ 不显示「折库存单位」列
              （原料档案无 conv 换算系数）；⑤ 需要新原料请先到「原料档案」新增，本版不代建。
            </Typography.Text>
          }
        />
      </Form>
    </Modal>
  )
}
