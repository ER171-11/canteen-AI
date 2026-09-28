import { Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { BomEntry } from '../../../api/types'
import { rk } from '../../../utils/rowKey'

/*
 * BOM 表：face_main/main/aux/seasoning 数组渲染。
 * 元素为对象时按首个元素的键生成列（原料名/用量/单位等），为字符串时单列展示。
 */
export default function BomTable({ data }: { data: BomEntry[] | string | undefined }) {
  if (data == null) {
    return <span style={{ color: '#999' }}>未配置</span>
  }

  /* 兼容后端下发字符串/对象等非数组形态，统一归一为数组再渲染 */
  const list: BomEntry[] = Array.isArray(data) ? data : [data]

  if (list.length === 0) {
    return <span style={{ color: '#999' }}>未配置</span>
  }

  if (typeof list[0] === 'string') {
    const columns: ColumnsType<string> = [
      { title: '内容', render: (v: string) => v },
    ]
    return (
      <Table<string>
        size="small"
        rowKey={(v) => String(v)}
        columns={columns}
        dataSource={list as string[]}
        pagination={false}
      />
    )
  }

  const rows = (list as Array<Record<string, string | number | undefined>>).filter(
    (r) => r && typeof r === 'object' && !Array.isArray(r),
  )
  if (rows.length === 0) {
    return <span style={{ color: '#999' }}>未配置</span>
  }
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
      rowKey={rk}
      columns={columns}
      dataSource={rows}
      pagination={false}
    />
  )
}
