import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Input, InputNumber, Modal, Space, Table, Tag, Tooltip, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { Link } from 'react-router-dom'
import { fetchRestockSuggest, fetchSnapshot, postAction } from '../../api'
import type { IngItem, RestockConfig, RestockPlan, RestockPlanLine } from '../../api/types'
import { useAuthStore } from '../../store/auth'
import MockAlert from '../kitchen/components/MockAlert'
import { safetyLine, stockStatus, suggestRestockQty } from './utils'
import { COLORS } from '../../theme'

interface RestockRow {
  id: string
  name: string
  cat?: string
  unit?: string
  buy?: string
  stock?: number
  safety: number
  suggestQty: number
  reason?: string
  urgency?: string
  /** 验收标准规格要求（服务端 restock-suggest.spec_req） */
  spec_req?: string
}

/** 行内可改字段（FP-PO-20）：采购量/供应商/起订量/整包规格 */
interface RowEdit {
  qty: number
  supplier: string
  moq: number
  packQty: number
}

const URGENCY_TAG: Record<string, { color: string; text: string }> = {
  critical: { color: COLORS.red, text: '告急' },
  low: { color: COLORS.yellow, text: '偏低' },
  watch: { color: 'default', text: '关注' },
}

/** 建议行状态标签（对齐旧版 lineStTag，旧 HTML:1913） */
const PLAN_LINE_TAG: Record<string, { color: string; text: string }> = {
  pending: { color: COLORS.orange, text: '待处理' },
  done: { color: COLORS.blue, text: '已转单' },
  closed: { color: COLORS.green, text: '已收货' },
  ignored: { color: COLORS.gray, text: '已忽略' },
}

/** 补货参数默认值（照抄旧版 RESTOCK_DEF，旧 HTML:5355） */
const RESTOCK_DEF: RestockConfig = { days: 30, lead: 1, gap: 1, useOnway: 1 }

export default function RestockPage() {
  const role = useAuthStore((s) => s.role)
  const account = useAuthStore((s) => s.account)
  const canWrite = useAuthStore((s) => s.canWrite)
  const [rows, setRows] = useState<RestockRow[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [isMock, setIsMock] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  /* FP-PO-17/19/20：快照侧数据（原料主数据 / 补货参数 / 最新建议单） */
  const [ings, setIngs] = useState<IngItem[]>([])
  const [cfg, setCfg] = useState<RestockConfig>(RESTOCK_DEF)
  const [plan, setPlan] = useState<RestockPlan | null>(null)
  const [edits, setEdits] = useState<Record<string, RowEdit>>({})
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgDraft, setCfgDraft] = useState<RestockConfig>(RESTOCK_DEF)

  /** 本地兜底算法（服务端端点不可用/无快照时用） */
  const localRows = (items: IngItem[]): RestockRow[] =>
    items
      .filter((g) => g.on !== false)
      .map((g) => ({
        id: String(g.id),
        name: g.name ?? String(g.id),
        cat: g.cat,
        unit: g.unit,
        buy: g.buy,
        stock: g.stock,
        safety: safetyLine(g),
        suggestQty: suggestRestockQty(g),
      }))
      .filter((g) => g.suggestQty > 0)
      .sort((a, b) => b.suggestQty - a.suggestQty)

  /* 通知人手的写权限/角色，供审批动作 operator 兜底 */
  const operator = role ?? account ?? '管理员'

  useEffect(() => {
    /* 优先服务端 /api/inventory/restock-suggest（est/plans 口径），失败回退本地安全线算法 */
    fetchRestockSuggest()
      .then((resp) => {
        if (resp.ok && !resp.mock && Array.isArray(resp.items) && resp.items.length > 0) {
          setRows(
            resp.items
              .map((it) => ({
                id: it.ingredientId,
                name: it.name ?? it.ingredientId,
                unit: it.unit,
                stock: it.qty,
                safety: it.safe ?? 0,
                suggestQty: it.suggestQty ?? 0,
                reason: it.reason,
                urgency: it.urgency,
                spec_req: it.spec_req,
              }))
              .filter((r) => r.suggestQty > 0),
          )
          setBanner(null)
        } else {
          setBanner(resp.banner || '服务端暂无补货建议，已回退本地安全线算法')
          return fetchSnapshot().then((snap) => setRows(localRows(snap.data?.ings ?? [])))
        }
        setIsMock(false)
        return undefined
      })
      .catch(() => {
        fetchSnapshot()
          .then((snap) => {
            setRows(localRows(snap.data?.ings ?? []))
            setBanner('服务端补货端点不可用，已回退本地安全线算法')
          })
          .catch(() => {
            setRows([])
            setIsMock(true)
          })
      })
      .finally(() => setLoading(false))
  }, [])

  /* FP-PO-17/19/20：另取快照，拿原料主数据（moq/packQty/sup）、补货参数、最新未忽略建议单；失败不阻塞建议清单 */
  useEffect(() => {
    fetchSnapshot()
      .then((snap) => {
        const d = snap.data
        setIngs(d?.ings ?? [])
        setCfg({ ...RESTOCK_DEF, ...(d?.restock ?? {}) })
        const usable = (d?.plans ?? [])
          .filter((p) => p && p.status !== 'ignored' && p.status !== '已忽略')
          .sort((a, b) => String(b.date || b.genAt || '').localeCompare(String(a.date || a.genAt || '')))
        setPlan(usable[0] ?? null)
      })
      .catch(() => {
        /* 快照不可用时：建议清单仍可只读浏览，忽略/调整按钮隐藏 */
      })
  }, [])

  const ingById = useMemo(() => {
    const m = new Map<string, IngItem>()
    for (const g of ings) m.set(String(g.id), g)
    return m
  }, [ings])

  /** 当前建议单的待处理行（按原料 id 索引），供行内编辑与忽略/调整 */
  const planLineByIng = useMemo(() => {
    const m = new Map<string, RestockPlanLine>()
    for (const l of plan?.lines ?? []) {
      if (l && l.ing) m.set(String(l.ing), l)
    }
    return m
  }, [plan])

  const hasPlan = !!plan

  /* 行内编辑初值：采购量取建议单行（若有）否则服务端建议量；供应商/起订/整包取原料主数据 */
  useEffect(() => {
    const next: Record<string, RowEdit> = {}
    for (const r of rows) {
      const line = planLineByIng.get(r.id)
      const g = ingById.get(r.id)
      next[r.id] = {
        qty: Number(line?.qty) > 0 ? Number(line?.qty) : r.suggestQty,
        supplier: String(line?.supplier ?? g?.sup ?? ''),
        moq: Number(g?.moq) || 0,
        packQty: Number(g?.packQty) || 0,
      }
    }
    setEdits(next)
  }, [rows, planLineByIng, ingById])

  useEffect(() => {
    setSelected(rows.map((r) => r.id))
  }, [rows])

  const patchEdit = (id: string, patch: Partial<RowEdit>) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { qty: 0, supplier: '', moq: 0, packQty: 0 }), ...patch } }))

  const columns: ColumnsType<RestockRow> = [
    { title: '原料', dataIndex: 'name' },
    { title: '分类', dataIndex: 'cat', width: 100, render: (v) => v ?? '-' },
    {
      title: '当前库存',
      key: 'stock',
      width: 110,
      align: 'right',
      render: (_, r) => `${r.stock ?? 0} ${r.unit ?? ''}`,
    },
    {
      title: '安全线',
      dataIndex: 'safety',
      width: 90,
      align: 'right',
      render: (v) => v || '-',
    },
    {
      title: '状态',
      key: 'st',
      width: 80,
      render: (_, r) => {
        if (r.urgency) {
          const t = URGENCY_TAG[r.urgency] ?? URGENCY_TAG.watch
          return <Tag color={t.color}>{t.text}</Tag>
        }
        const s = stockStatus(r as unknown as IngItem)
        return <Tag color={s.color}>{s.text}</Tag>
      },
    },
    {
      /* FP-PO-20 建议采购量：可编辑（需有建议单且当前行属待处理），保存时随 restock.adjust 落库 */
      title: '建议采购量',
      dataIndex: 'suggestQty',
      width: 150,
      align: 'right',
      render: (v, r) => {
        const line = planLineByIng.get(r.id)
        const editable = canWrite && !isMock && !!line && line.st === 'pending'
        if (!editable) return `${edits[r.id]?.qty ?? v} ${r.unit ?? ''}`
        return (
          <Space size={4}>
            <InputNumber
              min={0}
              step={1}
              style={{ width: 90 }}
              value={edits[r.id]?.qty ?? v}
              onChange={(n) => patchEdit(r.id, { qty: Number(n) || 0 })}
            />
            <span style={{ color: '#8c8c8c' }}>{line?.buy || r.unit || ''}</span>
          </Space>
        )
      },
    },
    {
      /* FP-PO-20 供应商：可编辑，保存时记回原料主数据 sup 并用于转单拆单 */
      title: '供应商',
      key: 'supplier',
      width: 150,
      render: (_, r) => {
        const line = planLineByIng.get(r.id)
        const editable = canWrite && !isMock && !!line && line.st === 'pending'
        if (!editable) return edits[r.id]?.supplier || '-'
        return (
          <Input
            style={{ width: 130 }}
            placeholder="按供应商拆单"
            value={edits[r.id]?.supplier ?? ''}
            onChange={(e) => patchEdit(r.id, { supplier: e.target.value })}
          />
        )
      },
    },
    {
      /* FP-PO-20 起订量 / 整包规格（采购单位）：保存时记回原料主数据 moq / packQty */
      title: '起订/整包',
      key: 'moqpack',
      width: 180,
      render: (_, r) => {
        const line = planLineByIng.get(r.id)
        const editable = canWrite && !isMock && !!line && line.st === 'pending'
        if (!editable) {
          const e = edits[r.id]
          return e && (e.moq || e.packQty) ? `${e.moq || 0} / ${e.packQty || 0}` : '-'
        }
        return (
          <Space size={4}>
            <Tooltip title="起订量（采购单位）">
              <InputNumber
                min={0}
                step={1}
                style={{ width: 70 }}
                value={edits[r.id]?.moq ?? 0}
                onChange={(n) => patchEdit(r.id, { moq: Number(n) || 0 })}
              />
            </Tooltip>
            <Tooltip title="整包规格（采购单位）">
              <InputNumber
                min={0}
                step={1}
                style={{ width: 70 }}
                value={edits[r.id]?.packQty ?? 0}
                onChange={(n) => patchEdit(r.id, { packQty: Number(n) || 0 })}
              />
            </Tooltip>
          </Space>
        )
      },
    },
    {
      title: '验收规格',
      dataIndex: 'spec_req',
      width: 180,
      ellipsis: true,
      render: (v) => v || '-',
    },
    {
      title: '建议行状态',
      key: 'planSt',
      width: 100,
      render: (_, r) => {
        const line = planLineByIng.get(r.id)
        if (!line) return <span style={{ color: '#bfbfbf' }}>不在建议单</span>
        const t = PLAN_LINE_TAG[String(line.st ?? 'pending')] ?? PLAN_LINE_TAG.pending
        return <Tag color={t.color}>{t.text}</Tag>
      },
    },
    {
      title: '依据',
      dataIndex: 'reason',
      ellipsis: true,
      render: (v) => v ?? '-',
    },
  ]

  /* FP-PO-18：勾选建议行 → 按供应商拆单生成正式采购单（order.fromRestock） */
  const onToOrders = async () => {
    const picked = rows.filter((r) => selected.includes(r.id))
    if (!picked.length) {
      message.warning('请先勾选要转采购单的原料')
      return
    }
    setSubmitting(true)
    try {
      const res = await postAction({
        type: 'order.fromRestock',
        operator,
        payload: {
          source: 'admin-web/inventory/restock',
          items: picked.map((r) => ({
            ing_id: r.id,
            name: r.name,
            qty: edits[r.id]?.qty ?? r.suggestQty,
            unit: r.unit,
            /* FP-PO-20：行内改过的供应商随转单一并保存（执行器回落原料 sup） */
            ...(edits[r.id]?.supplier ? { supplier: edits[r.id].supplier } : {}),
          })),
        },
      })
      message.success(
        res.dedup
          ? `已入队（幂等）：${res.id}，请到审批中心确认`
          : `转采购单已入队：${res.id}，请到审批中心确认执行`,
      )
    } catch {
      message.error('提交失败，请检查 BFF 与登录态')
    } finally {
      setSubmitting(false)
    }
  }

  /* FP-PO-19：忽略勾选的建议行（restock.ignore，只置 st=ignored，不生成采购单） */
  const onIgnore = async () => {
    const picked = rows.filter((r) => selected.includes(r.id)).map((r) => r.id)
    if (!picked.length) {
      message.warning('请先勾选要忽略的建议行')
      return
    }
    setSubmitting(true)
    try {
      const res = await postAction({
        type: 'restock.ignore',
        operator,
        payload: { source: 'admin-web/inventory/restock', ing_ids: picked },
      })
      message.success(`忽略已入队：${res.id}，请到审批中心确认执行`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败（可能当前行已转单/已忽略）')
    } finally {
      setSubmitting(false)
    }
  }

  /* FP-PO-20：保存行内改动 → restock.adjust（记回原料主数据 sup/moq/packQty + 建议行 qty/supplier） */
  const onSaveAdjust = async () => {
    const payloadRows = rows
      .filter((r) => planLineByIng.has(r.id))
      .map((r) => ({
        ing: r.id,
        qty: edits[r.id]?.qty ?? r.suggestQty,
        supplier: edits[r.id]?.supplier ?? '',
        moq: edits[r.id]?.moq ?? 0,
        packQty: edits[r.id]?.packQty ?? 0,
      }))
    if (!payloadRows.length) {
      message.warning('当前建议行不在待处理建议单内，无法记回；可先到店内「重新测算」生成建议单')
      return
    }
    setSubmitting(true)
    try {
      const res = await postAction({
        type: 'restock.adjust',
        operator,
        payload: { source: 'admin-web/inventory/restock', rows: payloadRows },
      })
      message.success(`调整已入队：${res.id}，请到审批中心确认执行（确认后记回原料主数据）`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  /* FP-PO-17：补货参数（restock.config） */
  const openCfg = () => {
    setCfgDraft({ ...cfg })
    setCfgOpen(true)
  }

  const onSaveCfg = async () => {
    setSubmitting(true)
    try {
      const res = await postAction({
        type: 'restock.config',
        operator,
        payload: { source: 'admin-web/inventory/restock', restock: cfgDraft },
      })
      message.success(`补货参数已入队：${res.id}，请到审批中心确认执行`)
      setCfgOpen(false)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      {isMock && <MockAlert endpoint="/api/inventory/restock-suggest" />}
      {banner && !isMock && (
        <Alert type="info" showIcon style={{ marginBottom: 16 }} message={banner} />
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={`只读建议：优先服务端 est/plans 口径，端点不可用时回退本地安全线计算；勾选后「转采购单」按供应商拆单生成正式采购单（不入库，收货请到「进货入库」登记）。补货参数：日均耗量近 ${cfg.days} 天 ×（提前期 ${cfg.lead} + 配送间隔 ${cfg.gap}）天${cfg.useOnway ? ' − 在途' : ''}。所有写操作经审批中心 confirm/execute 生效，不会直连店内 8765。`}
        action={
          <Link to="/platform/actions">审批中心</Link>
        }
      />
      <Card
        title="补货建议"
        extra={
          <Space>
            <span>{rows.length} 项需补货</span>
            {/* FP-PO-17 补货参数配置（走 restock.config 审批队列） */}
            <Tooltip title={canWrite ? undefined : '当前角色无写权限，仅可查看'}>
              <Button disabled={!canWrite || isMock} onClick={openCfg}>
                补货参数
              </Button>
            </Tooltip>
            {/* FP-PO-19 忽略勾选：只在存在待处理建议单时可用 */}
            <Tooltip
              title={
                !canWrite
                  ? '当前角色无写权限，仅可查看'
                  : hasPlan
                    ? undefined
                    : '当前没有待处理的补货建议单（忽略仅作用于建议单行）'
              }
            >
              <Button loading={submitting} disabled={!canWrite || isMock || !hasPlan} onClick={onIgnore}>
                忽略勾选
              </Button>
            </Tooltip>
            {/* FP-PO-20 保存行内调整（采购量/供应商/起订/整包）并记回原料主数据 */}
            <Tooltip
              title={
                !canWrite
                  ? '当前角色无写权限，仅可查看'
                  : hasPlan
                    ? undefined
                    : '当前没有待处理的补货建议单（调整仅作用于建议单行）'
              }
            >
              <Button loading={submitting} disabled={!canWrite || isMock || !hasPlan} onClick={onSaveAdjust}>
                保存调整
              </Button>
            </Tooltip>
            <Button
              type="primary"
              loading={submitting}
              disabled={!rows.length || !canWrite}
              title={canWrite ? undefined : '当前角色无写权限，仅可查看'}
              onClick={onToOrders}
            >
              转采购单
            </Button>
          </Space>
        }
      >
        {plan && (
          <div style={{ marginBottom: 8, color: '#8c8c8c', fontSize: 12 }}>
            建议单 <b>{plan.no ?? plan.id}</b>（{plan.date ?? ''} · {plan.by === 'auto' ? '系统自动' : plan.by === 'manual' ? '手工' : String(plan.by ?? '')}生成）
            · 状态 {plan.status ?? 'pending'} · 共 {plan.lines?.length ?? 0} 行
          </div>
        )}
        <Table<RestockRow>
          rowKey="id"
          columns={columns}
          dataSource={rows}
          loading={loading}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys as string[]),
            getCheckboxProps: (r) => {
              const line = planLineByIng.get(r.id)
              /* 已转单/已收货/已忽略的行不可再选（对齐旧版 dis 行） */
              return line && line.st !== 'pending' ? { disabled: true } : {}
            },
          }}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 1400 }}
          locale={{
            emptyText: (
              <span style={{ color: COLORS.green }}>当前库存均高于安全线，无需补货</span>
            ),
          }}
        />
      </Card>

      {/* FP-PO-17 补货参数配置（对齐旧版 openRestockCfg，旧 HTML:2031-2051） */}
      <Modal
        title="补货参数"
        open={cfgOpen}
        onCancel={() => setCfgOpen(false)}
        onOk={onSaveCfg}
        confirmLoading={submitting}
        okText="提交入队"
      >
        <div style={{ lineHeight: 2.2 }}>
          <div>日均耗量统计天数</div>
          <InputNumber
            min={1}
            step={1}
            style={{ width: '100%' }}
            value={cfgDraft.days}
            onChange={(n) => setCfgDraft((p) => ({ ...p, days: Math.max(1, Math.floor(Number(n) || 1)) }))}
          />
          <div>提前期（下单到到货，天）</div>
          <InputNumber
            min={0}
            step={1}
            style={{ width: '100%' }}
            value={cfgDraft.lead}
            onChange={(n) => setCfgDraft((p) => ({ ...p, lead: Math.max(0, Number(n) || 0) }))}
          />
          <div>配送间隔（两次到货相隔，天）</div>
          <InputNumber
            min={0}
            step={1}
            style={{ width: '100%' }}
            value={cfgDraft.gap}
            onChange={(n) => setCfgDraft((p) => ({ ...p, gap: Math.max(0, Number(n) || 0) }))}
          />
          <div>扣减未结案采购量（在途）</div>
          <InputNumber
            min={0}
            max={1}
            step={1}
            style={{ width: '100%' }}
            value={cfgDraft.useOnway}
            onChange={(n) => setCfgDraft((p) => ({ ...p, useOnway: Number(n) ? 1 : 0 }))}
          />
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 8 }}
            message="1 = 扣减在途（防重复下单），0 = 不扣减。建议量 = 日均耗量 ×(提前期 + 配送间隔) + 安全库存 − 现有库存 − 在途，再套「起订量」并按「整包规格」向上取整。改完请到店内「重新测算」刷新建议。"
          />
        </div>
      </Modal>
    </div>
  )
}
