import { useEffect, useMemo, useRef, useState } from 'react'
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
 * 新建 / 编辑 CG 采购单，逐字段移植旧版 openOrder / openDocForm（旧 HTML:1559-1675）。
 *
 * 红线：不直写库——只向 /api/actions 投一条 `po.create`（新建）或 `po.edit`（编辑），
 *   确认由审批中心 + 店内消费器完成。执行器 applyOrderCreate / applyOrderEdit 已存在。
 *   采购单**不入库、不影响库存与均价**（旧版 openDocForm stockIn=false），执行器只改 data.orders。
 *
 * 编辑模式（editDoc 非空）：预填原单、提交 `po.edit`。
 *
 * 与旧版的**已知差异**（都写在界面上，不静默）：
 *   1. 已恢复旧版明细「＋新增原料」（openNewIngForPo 代建）：下拉选「＋ 新增原料（列表中没有）…」，
 *      弹窗填名/单位/分类/单价后，本单提交时由执行器按名自动建档（待完善草稿）。
 *   2. 旧版显示「折库存单位」列，本版按原料主数据 conv 折算展示（conv 缺失按 1）。
 *   3. 编辑提交会按旧版口径把 `payments` 归并为「本次实付」单条；预填实付=已付合计，
 *      故应付/已付/欠款三数不变，仅付款笔数归并。
 */

/** 旧版 openDocForm 付款方式 5 项（HTML:1583，与「付款登记 openGet」的 6 项枚举不同，勿混用） */
export const ORDER_FORM_METHODS = ['现金/转账', '微信', '支付宝', '银行转账', '部分挂账'] as const

interface LineRow {
  ing_id?: string
  /** 新增原料：无 ing_id，直接用名称（提交时执行器按名自动建档） */
  name?: string
  /** 新增原料采购单位 */
  unit?: string
  /** 新增原料分类 */
  cat?: string
  qty?: number
  price?: number
}

/** 本单会话内新建的原料草稿（提交时按 name/unit/cat 下发，由执行器自动建档） */
interface NewIngDraft {
  key: string
  name: string
  unit: string
  cat: string
  price: number
}

interface FormVals {
  date: Dayjs
  supplier: string
  note?: string
  method: string
  paid?: number
  /** 整单优惠/抹零（让利不摊入成本，应付 = 明细合计 − 优惠） */
  discount?: number
  items?: LineRow[]
}

export interface OrderFormModalProps {
  open: boolean
  /** 非空 = 编辑模式（预填该单并提交 po.edit）；空 = 新建（提交 po.create） */
  editDoc?: InventoryDoc | null
  /**
   * FP-DASH-12 新建时预置原料（旧版 `openOrder(null, presetIng)` → `openDocForm` 的 presetIng 分支，
   * HTML:1560）：明细首行 = `{ing, qty: conv||1, price: last||avg}`。仅新建模式生效。
   */
  prefillIngId?: string | null
  ings: IngItem[]
  suppliers: string[]
  onClose: () => void
  onQueued?: () => void
}

export default function OrderFormModal({
  open,
  editDoc,
  prefillIngId,
  ings,
  suppliers,
  onClose,
  onQueued,
}: OrderFormModalProps) {
  const isEdit = !!(editDoc && (editDoc.id || editDoc.no))
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [form] = Form.useForm<FormVals>()
  /* 新增原料弹窗 + 本单会话内的草稿（旧版 openNewIngForPo 回归） */
  const [newIngForm] = Form.useForm<{ name: string; unit?: string; cat?: string; price?: number }>()
  const [newIngs, setNewIngs] = useState<NewIngDraft[]>([])
  const newIngSeq = useRef(0)
  const [newIngOpen, setNewIngOpen] = useState(false)
  const [newIngRow, setNewIngRow] = useState<number | null>(null)
  const watchedRows = Form.useWatch('items', form) as LineRow[] | undefined
  const rows = useMemo(() => watchedRows ?? [], [watchedRows])
  const paidWatch = Form.useWatch('paid', form) as number | undefined
  const discountWatch = Form.useWatch('discount', form) as number | undefined

  const ingById = useMemo(() => {
    const m = new Map<string, IngItem>()
    for (const g of ings) m.set(String(g.id), g)
    return m
  }, [ings])

  /**
   * 表单初值（旧版 openOrder/openDocForm 预填口径）：
   *   编辑模式 → 原单（HTML:1642-1643 同字段）；新建 → 日期=今天、付款方式=首项、
   *   明细首行 = 带入原料（FP-DASH-12，旧版 presetIng：qty=conv||1、price=last||avg，HTML:1560）
   *   或第一个原料（旧版 HTML:1626）。
   *
   * ⚠️ 必须走 `initialValues` 而**不能只** `form.setFieldsValue`：Form.List 在挂载前
   *    拿不到 setFieldsValue 写入的行，会渲染成「0 行明细」（阶段 26 只做静态检查，
   *    漏掉了这个真机上必现的缺陷；带原料进入的 FP-DASH-12 首行也依赖它）。
   */
  const initialVals = useMemo<FormVals>(() => {
    if (isEdit && editDoc) {
      return {
        date: editDoc.date ? dayjs(String(editDoc.date)) : dayjs(),
        supplier: editDoc.supplier || '',
        note: editDoc.note || '',
        method: editDoc.method || ORDER_FORM_METHODS[0],
        /* 预填「实付」= 已付合计：编辑后应付/已付/欠款不变（仅付款笔数按旧版口径归并） */
        paid: r2((editDoc.payments ?? []).reduce((a, p) => a + (Number(p?.amount) || 0), 0)),
        discount: Number(editDoc.discount) || 0,
        items: (editDoc.lines ?? []).map((l) => ({
          ing_id: String(l.ing ?? ''),
          qty: Number(l.qty) || 0,
          price: Number(l.price) || 0,
        })),
      }
    }
    const preset = prefillIngId ? ingById.get(String(prefillIngId)) : null
    const first = preset || ings[0]
    return {
      date: dayjs(),
      supplier: '',
      method: ORDER_FORM_METHODS[0],
      paid: 0,
      discount: 0,
      items: first
        ? [
            {
              ing_id: String(first.id),
              qty: preset ? Number(first.conv) || 1 : 1,
              price: Number(first.last ?? first.avg) || 0,
            },
          ]
        : [{ qty: 1 }],
    }
  }, [isEdit, editDoc, prefillIngId, ings, ingById])

  /* 每次打开都回到初值（弹窗 destroyOnHidden，初值随 ings/带入原料/编辑单变化而重算）。
     延后一帧再写：Form.List 必须在其行字段挂载**之后**才能接到写入的行值（否则渲染成空行）。 */
  useEffect(() => {
    if (!open) return
    setNewIngs([])
    newIngSeq.current = 0
    setNewIngOpen(false)
    setNewIngRow(null)
    const t = setTimeout(() => {
      form.resetFields()
      form.setFieldsValue(initialVals)
    }, 0)
    return () => clearTimeout(t)
  }, [open, initialVals, form])

  const gross = useMemo(
    () => r2(rows.reduce((a, r) => a + (Number(r?.qty) || 0) * (Number(r?.price) || 0), 0)),
    [rows],
  )
  const discount = r2(Number(discountWatch) || 0)
  const payable = r2(Math.max(0, gross - discount))
  const paid = r2(Number(paidWatch) || 0)
  const debt = r2(Math.max(0, payable - paid))

  const ingOptions = useMemo(
    () => [
      ...ings.map((g) => ({
        value: String(g.id),
        label: `${g.name}${g.buy || g.unit ? `（${g.buy || g.unit}）` : ''}`,
      })),
      ...newIngs.map((n) => ({
        value: n.key,
        label: `${n.name}（${n.unit || '斤'}）·新`,
      })),
      { value: '__new__', label: '＋ 新增原料（列表中没有）…' },
    ],
    [ings, newIngs],
  )

  const invalid = !(gross > 0) || discount > gross + 0.01 || paid > payable + 0.01

  const submit = async () => {
    const v = await form.validateFields()
    const list = (v.items ?? []).filter((r) => {
      if (!r) return false
      const g = r.ing_id ? ingById.get(String(r.ing_id)) : undefined
      if (g) return true
      return !!(r.name && String(r.name).trim())
    })
    if (!list.length) {
      message.warning('请至少填写一行明细（原料 + 数量）')
      return
    }
    const sum = r2(list.reduce((a, r) => a + (Number(r.qty) || 0) * (Number(r.price) || 0), 0))
    if (!(sum > 0)) {
      message.warning('明细合计需大于 0，请检查数量/单价')
      return
    }
    const disc = r2(Number(v.discount) || 0)
    if (disc > sum + 0.01) {
      message.warning('整单优惠不得超过明细合计（让利不得高于应付）')
      return
    }
    const net = r2(sum - disc)
    if (!(net > 0)) {
      message.warning('应付合计需大于 0，请调整优惠金额')
      return
    }
    const pay = r2(Number(v.paid) || 0)
    if (pay > net + 0.01) {
      message.warning('实付不得超过应付合计（超付会被封顶到应付）')
      return
    }
    try {
      await postAction({
        type: isEdit ? 'po.edit' : 'po.create',
        operator: role ?? account ?? 'admin',
        payload: {
          ...(isEdit ? { order_id: String(editDoc?.id ?? editDoc?.no ?? '') } : {}),
          supplier: String(v.supplier).trim(),
          date: v.date ? v.date.format('YYYY-MM-DD') : today(),
          note: v.note?.trim() || undefined,
          method: v.method,
          paid: pay,
          discount: disc,
          items: list.map((r) => {
            const g = r.ing_id ? ingById.get(String(r.ing_id)) : undefined
            if (g) {
              return {
                ing_id: String(g.id),
                name: g.name,
                qty: Number(r.qty) || 0,
                price: Number(r.price) || 0,
              }
            }
            /* 新增原料：不带 ing_id，靠 name 让执行器 resolveIngRef 自动建档 */
            return {
              name: String(r.name ?? '').trim(),
              ...(r.unit ? { unit: String(r.unit).trim() } : {}),
              ...(r.cat ? { cat: String(r.cat).trim() } : {}),
              qty: Number(r.qty) || 0,
              price: Number(r.price) || 0,
            }
          }),
          source: 'admin-web/inventory/purchase',
        },
      })
      message.success(
        isEdit
          ? '采购单修改已入队 → 请到审批中心确认执行'
          : '采购单已入队 → 请到审批中心确认执行（采购单不入库，收货请到「进货入库」登记）',
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
    <>
      <Modal
        title={isEdit ? `编辑 CG 采购单 · ${editDoc?.no ?? editDoc?.id ?? ''}` : '新建 CG 采购单'}
      open={open}
      width={900}
      onCancel={onClose}
      okText={isEdit ? '提交修改' : '提交入队'}
      cancelText="取消"
      okButtonProps={{ disabled: invalid }}
      onOk={submit}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" initialValues={initialVals}>
        <Space size="middle" wrap style={{ display: 'flex' }}>
          <Form.Item label="采购日期" name="date" rules={[{ required: true, message: '请选日期' }]}>
            <DatePicker allowClear={false} style={{ width: 150 }} />
          </Form.Item>
          <Form.Item
            label="供应商"
            name="supplier"
            rules={[
              { required: true, whitespace: true, message: '请填写供应商（旧版必填，否则拒绝保存）' },
            ]}
            style={{ width: 260 }}
          >
            <AutoComplete
              options={suppliers.map((s) => ({ value: s }))}
              placeholder="供应商名称"
              filterOption={(input, opt) =>
                String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>
        </Space>

        <Form.Item label="备注" name="note">
          <Input placeholder="如：早市到货 / 冷链" />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          采购明细（数量/单价均按采购单位）
        </Typography.Text>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0' }}>
          {headCell('原料', 240)}
          {headCell('数量', 100, 'right')}
          {headCell('单价(元)', 110, 'right')}
          {headCell('金额', 100, 'right')}
          {headCell('折库存单位', 120, 'right')}
          {headCell('操作', 60, 'right')}
        </div>

        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field) => {
                const g = ingById.get(String(rows[field.name]?.ing_id ?? ''))
                const conv = Number(g?.conv) || 1
                return (
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
                          if (id === '__new__') {
                            setNewIngRow(field.name)
                            setNewIngOpen(true)
                            return
                          }
                          const gg = ingById.get(String(id))
                          const n = newIngs.find((x) => x.key === String(id))
                          const list = [...(form.getFieldValue('items') ?? [])]
                          list[field.name] = {
                            ...list[field.name],
                            ing_id: id,
                            name: gg ? undefined : n?.name,
                            unit: gg ? undefined : n?.unit,
                            cat: gg ? undefined : n?.cat,
                            price: Number(gg?.last ?? gg?.avg ?? n?.price) || 0,
                          }
                          form.setFieldsValue({ items: list })
                        }}
                      />
                    </Form.Item>
                    <Form.Item
                      name={[field.name, 'qty']}
                      rules={[{ required: true, message: '数量' }]}
                      style={{ marginBottom: 8 }}
                    >
                      <InputNumber min={0} step={1} style={{ width: 100 }} placeholder="数量" />
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
                    <div style={{ width: 120, textAlign: 'right', paddingTop: 4, color: '#8c8c8c' }}>
                      {g ? `${fmt((Number(rows[field.name]?.price) || 0) / conv)} 元/${g.unit || ''}` : '—'}
                    </div>
                    <Button type="link" size="small" style={{ width: 60 }} onClick={() => remove(field.name)}>
                      删
                    </Button>
                  </Space>
                )
              })}
              <Button
                style={{ marginTop: 4 }}
                onClick={() => add({ qty: 1, price: Number(ings[0]?.last ?? ings[0]?.avg) || 0 })}
              >
                ＋ 添加原料
              </Button>
            </>
          )}
        </Form.List>

        <div style={{ marginTop: 8, display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ paddingBottom: 4 }}>
            明细合计：<b>¥{fmt(gross)}</b>
          </div>
          <Form.Item
            label="整单优惠/抹零（元，让利不摊入成本）"
            name="discount"
            style={{ marginBottom: 0 }}
          >
            <InputNumber min={0} max={gross} step={0.01} style={{ width: 130 }} placeholder="0" />
          </Form.Item>
          <div style={{ paddingBottom: 4 }}>
            应付合计：<b>¥{fmt(payable)}</b>
          </div>
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
              options={ORDER_FORM_METHODS.map((m) => ({ value: m, label: m }))}
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
          message="提交后进入审批中心，确认后由店内消费器执行（采购单不入库、不影响库存与均价）"
          description={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              本版已知差异：① 明细下拉可「＋ 新增原料」——本单直接按名自动建档（待完善草稿）；
              ② 折库存单位按原料 conv 折算（缺失按 1）；③ 编辑保存按旧版口径把付款记录归并为「本次实付」单条，
              金额口径不变。
            </Typography.Text>
          }
        />
      </Form>
      </Modal>

      <Modal
        title="新增原料（本单直接按名建档，提交后到原料档案确认）"
        open={newIngOpen}
        width={460}
        onCancel={() => {
          if (newIngRow != null) {
            const list = [...(form.getFieldValue('items') ?? [])]
            if (list[newIngRow]) {
              list[newIngRow] = { ...list[newIngRow], ing_id: undefined }
              form.setFieldsValue({ items: list })
            }
          }
          setNewIngOpen(false)
          setNewIngRow(null)
        }}
        okText="确定并加入本单"
        onOk={async () => {
          const vals = await newIngForm.validateFields()
          const name = String(vals.name ?? '').trim()
          if (!name) return
          const key = '__new_' + newIngSeq.current++
          const unit = String(vals.unit ?? '').trim() || '斤'
          const cat = String(vals.cat ?? '').trim() || '其他'
          const price = Number(vals.price) || 0
          setNewIngs((prev) => [...prev, { key, name, unit, cat, price }])
          if (newIngRow != null) {
            const list = [...(form.getFieldValue('items') ?? [])]
            list[newIngRow] = {
              ...list[newIngRow],
              ing_id: key,
              name,
              unit,
              cat,
              price,
            }
            form.setFieldsValue({ items: list })
          }
          setNewIngOpen(false)
          setNewIngRow(null)
        }}
        destroyOnHidden
      >
        <Form form={newIngForm} layout="vertical">
          <Form.Item
            label="原料名称"
            name="name"
            rules={[{ required: true, whitespace: true, message: '请输入原料名称' }]}
          >
            <Input placeholder="如：娃娃菜 / 猪里脊" />
          </Form.Item>
          <Space size="middle" wrap>
            <Form.Item label="采购单位" name="unit">
              <Input placeholder="斤 / 袋 / 箱" style={{ width: 120 }} />
            </Form.Item>
            <Form.Item label="分类" name="cat">
              <Input placeholder="其他" style={{ width: 120 }} />
            </Form.Item>
            <Form.Item label="本次单价（元）" name="price">
              <InputNumber min={0} step={0.01} style={{ width: 120 }} placeholder="0" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  )
}
