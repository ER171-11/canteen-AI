import { Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { BomEntry } from '../../../api/types'

/*
 * BOM 表：face_main/main/aux/seasoning 数组渲染。
 * 元素为对象时按首个元素的键生成列（原料名/用量/单位等），为字符串时单列展示。
 */
export default function BomTable({ data }: { data: BomEntry[] | undefined }) {
  if (!data || data.length === 0) {
    return <span style={{ color: '#999' }}>未配置</span>
  }

  if (typeof data[0] === 'string') {
    const columns: ColumnsType<string> = [
      { title: '内容', render: (v: string) => v },
    ]
    return (
      <Table<string>
        size="small"
        rowKey={(_, i) => String(i)}
        columns={columns}
        dataSource={data as string[]}
        pagination={false}
      />
    )
  }

  const rows = data as Array<Record<string, string | number | undefined>>
  const keys = Object.keys(rows[0])
  const columns: ColumnsType<Record<string, string | number | undefined>> =
    keys.map((k) => ({
      title: k,
      dataIndex: k,
      render: (v: string | number | undefined) => (v === undefined ? '-' : String(v)),
    }))
  return (
    <Table
      size="small"
      rowKey={(_, i) => String(i)}
      columns={columns}
      dataSource={rows}
      pagination={false}
    />
  )
}
