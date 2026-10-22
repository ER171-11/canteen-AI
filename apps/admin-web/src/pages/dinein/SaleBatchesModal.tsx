import { useCallback, useEffect, useState } from 'react'
import { Button, Empty, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { postAction } from '../../api'
import { SALE_AMT_MODES, fetchSaleBatches } from '../../api/saleImport'
import type { SaleBatch } from '../../api/saleImport'
import { useAuthStore } from '../../store/auth'
import { fmt } from '../inventory/settle/data'

/**
 * FP-SALE-04 外部销售批次管理（撤回）+ FP-SALE-05 金额口径事后重算。
 * 撤回：整批作废留痕（sale.batch_void），不物理删除、不回补库存（FP-SALE-13 决策），撤回后可重新导入。
 * 重算：对某批次按新口径重新计算 amount/discount/receivable（sale.amt_recalc），只改金额不动明细。
 */
export interface SaleBatchesModalProps {
  open: boolean
  onClose: () => void
  onQueued?: () => void
}

export default function SaleBatchesModal({ open, onClose, onQueued }: SaleBatchesModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [batches, setBatches] = useState<SaleBatch[]>([])
  const [recalcMode, setRecalcMode] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetchSaleBatches()
      setBatches(r.batches ?? [])
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '加载批次失败')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const operator = role ?? account ?? 'admin'

  const doVoid = async (batch: string) => {
    setBusy(true)
    try {
      await postAction({ type: 'sale.batch_void', operator, payload: { batch, reason: '批次管理撤回' } })
      message.success('撤回已入队 → 请到审批中心确认（作废留痕，不回补库存）')
      onQueued?.()
      await load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '撤回提交失败')
    } finally {
      setBusy(false)
    }
  }

  const doRecalc = async (batch: string, mode: string) => {
    if (!mode) {
      message.warning('请先选择要重算的金额口径')
      return
    }
    setBusy(true)
    try {
      await postAction({ type: 'sale.amt_recalc', operator, payload: { batch, mode } })
      message.success('重算已入队 → 请到审批中心确认')
      onQueued?.()
      setRecalcMode((prev) => ({ ...prev, [batch]: '' }))
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '重算提交失败')
    } finally {
      setBusy(false)
    }
  }

  const cols: ColumnsType<SaleBatch> = [
    {
      title: '批次号',
      dataIndex: 'batch',
      render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
    },
    { title: '来源', dataIndex: 'srcName', width: 100 },
    {
      title: '期间',
      width: 190,
      render: (_, r) => (
        <Typography.Text type="secondary">
          {r.dateMin}
          {r.dateMax && r.dateMax !== r.dateMin ? ` ~ ${r.dateMax}` : ''}
        </Typography.Text>
      ),
    },
    { title: '单据数', dataIndex: 'count', width: 80, align: 'right' },
    { title: '应收', dataIndex: 'receivable', width: 110, align: 'right', render: (v: number) => `¥${fmt(Number(v) || 0)}` },
    {
      title: '状态',
      width: 130,
      render: (_, r) => (
        <Space size={4}>
          {r.settled ? <Tag color="green">已结算</Tag> : <Tag>挂账</Tag>}
          {r.voided > 0 ? <Tag color="red">已撤回 {r.voided}</Tag> : null}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 300,
      render: (_, r) => (
        <Space wrap size={4}>
          <Select
            size="small"
            style={{ width: 170 }}
            placeholder="重算口径"
            allowClear
            value={recalcMode[r.batch]}
            onChange={(v) => setRecalcMode((prev) => ({ ...prev, [r.batch]: v as string }))}
            options={Object.entries(SALE_AMT_MODES).map(([k, v]) => ({ label: `${k} · ${v}`, value: k }))}
          />
          <Button size="small" onClick={() => doRecalc(r.batch, recalcMode[r.batch] || '')}>
            重算
          </Button>
          {r.voided < r.count ? (
            <Popconfirm
              title="确认整批撤回？"
              description="该批次所有销售单将作废留痕（不删除、不回补库存），撤回后可重新导入"
              okText="撤回"
              cancelText="取消"
              onConfirm={() => doVoid(r.batch)}
            >
              <Button size="small" danger>
                撤回
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ]

  return (
    <Modal
      title="外部销售批次（撤回 / 重算）"
      open={open}
      width={900}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {batches.length ? (
        <Table<SaleBatch>
          size="small"
          rowKey="batch"
          columns={cols}
          dataSource={batches}
          loading={busy}
          pagination={false}
        />
      ) : (
        <Empty description={busy ? '加载中…' : '还没有外部销售批次'} />
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        撤回 = 整批作废留痕（FP-SALE-13 决策：作废不回补库存）；重算 = 按所选口径重算该批次金额（口径唯一出口在 BFF 侧 resolveSaleAmt）。
      </Typography.Paragraph>
    </Modal>
  )
}
