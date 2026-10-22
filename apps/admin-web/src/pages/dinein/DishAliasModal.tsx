import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Empty, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { postAction } from '../../api'
import { fetchSaleAlias } from '../../api/saleImport'
import type { SaleAlias, SaleDishOption } from '../../api/saleImport'
import { useAuthStore } from '../../store/auth'

/**
 * FP-SALE-06 菜名映射（平台菜名 → 本店菜品）。
 * 三级匹配的第一级「别名」：导入时平台菜名先查这张表，命中即直接映射（可选倍数，如 1 份=2 个）。
 * 写走 sale.alias_set / sale.alias_delete（审批队列）；读走 GET /sales/import/alias。
 */
export interface DishAliasModalProps {
  open: boolean
  onClose: () => void
  onQueued?: () => void
}

export default function DishAliasModal({ open, onClose, onQueued }: DishAliasModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [aliases, setAliases] = useState<SaleAlias[]>([])
  const [onDishes, setOnDishes] = useState<SaleDishOption[]>([])
  const [newName, setNewName] = useState('')
  const [newDish, setNewDish] = useState('')
  const [newMul, setNewMul] = useState(1)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const r = await fetchSaleAlias()
      setAliases(r.aliases ?? [])
      setOnDishes(r.onDishes ?? [])
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '加载映射失败')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const operator = role ?? account ?? 'admin'

  const dishOpts = useMemo(() => onDishes.map((d) => ({ label: d.name, value: d.id })), [onDishes])

  const add = async () => {
    const name = newName.trim()
    if (!name || !newDish) {
      message.warning('请填写平台菜名并选择本店菜品')
      return
    }
    setBusy(true)
    try {
      await postAction({ type: 'sale.alias_set', operator, payload: { name, dish: newDish, mul: newMul } })
      message.success('映射已入队 → 请到审批中心确认')
      onQueued?.()
      setNewName('')
      setNewDish('')
      setNewMul(1)
      await load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '新增失败')
    } finally {
      setBusy(false)
    }
  }

  const del = async (name: string) => {
    setBusy(true)
    try {
      await postAction({ type: 'sale.alias_delete', operator, payload: { name } })
      message.success('删除已入队 → 请到审批中心确认')
      onQueued?.()
      await load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '删除失败')
    } finally {
      setBusy(false)
    }
  }

  const cols: ColumnsType<SaleAlias> = [
    { title: '平台菜名', dataIndex: 'name' },
    { title: '本店菜品', dataIndex: 'dishName', render: (v: string, r) => `${v}（${r.dish}）` },
    { title: '倍数', dataIndex: 'mul', width: 80, align: 'right', render: (v: number) => `×${v}` },
    {
      title: '操作',
      width: 90,
      render: (_, r) => (
        <Popconfirm title="删除这条映射？" okText="删除" cancelText="取消" onConfirm={() => del(r.name)}>
          <Button size="small" danger>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ]

  return (
    <Modal title="菜名映射（平台菜名 → 本店菜品）" open={open} width={680} footer={null} onCancel={onClose} destroyOnHidden>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space wrap>
          <Input
            style={{ width: 200 }}
            placeholder="平台菜名（如：美团·五福水饺）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <Select
            style={{ width: 200 }}
            placeholder="本店菜品"
            showSearch
            optionFilterProp="label"
            options={dishOpts}
            value={newDish || undefined}
            onChange={(v) => setNewDish(v as string)}
          />
          <InputNumber min={0.1} step={0.1} value={newMul} onChange={(v) => setNewMul(Number(v) || 1)} style={{ width: 80 }} />
          <Button type="primary" loading={busy} onClick={add}>
            新增映射
          </Button>
        </Space>

        {aliases.length ? (
          <Table<SaleAlias> size="small" rowKey="name" columns={cols} dataSource={aliases} loading={busy} pagination={false} />
        ) : (
          <Empty description={busy ? '加载中…' : '还没有菜名映射'} />
        )}

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          导入时平台菜名先按「别名 → 精确 → 归一化」三级匹配本店菜品；此处配置的别名优先级最高，倍数用于「1 份 = N 个」的换算。
        </Typography.Text>
      </Space>
    </Modal>
  )
}
