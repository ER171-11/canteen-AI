import { useEffect, useMemo, useState } from 'react'
import { Card, Input, Select, Space, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchAdminDishes } from '../../api'
import type { Dish } from '../../api/types'
import MockAlert from './components/MockAlert'
import { MOCK_DISHES } from './mock'
import { COLORS } from '../../theme'

export default function DishesPage() {
  const [items, setItems] = useState<Dish[]>([])
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [cat, setCat] = useState<string | undefined>()
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    fetchAdminDishes()
      .then((resp) => setItems(resp.items ?? []))
      .catch(() => {
        setItems(MOCK_DISHES)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const cats = useMemo(
    () => [...new Set(items.map((d) => d.cat).filter(Boolean))] as string[],
    [items],
  )

  const filtered = useMemo(
    () =>
      items.filter(
        (d) =>
          (!cat || d.cat === cat) &&
          (!keyword || d.name.includes(keyword.trim())),
      ),
    [items, cat, keyword],
  )

  const columns: ColumnsType<Dish> = [
    { title: '菜品名', dataIndex: 'name', sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN') },
    { title: '分类', dataIndex: 'cat', width: 120, render: (v) => v ?? '-' },
    {
      title: '售价',
      dataIndex: 'price',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
      sorter: (a, b) => (a.price ?? 0) - (b.price ?? 0),
    },
    {
      title: '成本 est',
      dataIndex: 'est',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${v}`),
    },
    {
      title: '销量 q',
      dataIndex: 'q',
      width: 90,
      align: 'right',
      sorter: (a, b) => (a.q ?? 0) - (b.q ?? 0),
    },
    {
      title: '上架',
      dataIndex: 'on',
      width: 90,
      render: (v: boolean | undefined) =>
        v ? <Tag color={COLORS.green}>上架中</Tag> : <Tag>已下架</Tag>,
    },
  ]

  return (
    <Card
      title="菜品菜单"
      extra={
        <Space>
          <Select
            allowClear
            placeholder="按分类筛选"
            style={{ width: 140 }}
            value={cat}
            onChange={setCat}
            options={cats.map((c) => ({ value: c, label: c }))}
          />
          <Input.Search
            allowClear
            placeholder="搜索菜品名"
            style={{ width: 200 }}
            onSearch={setKeyword}
            onChange={(e) => !e.target.value && setKeyword('')}
          />
        </Space>
      }
    >
      {isMock && <MockAlert endpoint="/api/admin/dishes" />}
      <Table<Dish>
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 道` }}
      />
    </Card>
  )
}
