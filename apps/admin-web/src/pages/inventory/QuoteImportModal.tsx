/*
 * QuoteImportModal.tsx — W2-04 / FP-PRICE-12 报价批量导入（ADR-013 D2）。
 *
 * 流程：选 JSON 文件（panda-quote-task 衍生契约）→ 前端解析 → /import/preview 只读预览
 * （命中/跳过/非法计数）→ 用户确认 → 投一个 quote.import 动作走 /api/actions 队列。
 *
 * 红线：本组件不发任何写请求；确认后只入队，真正的写由 BFF 执行器在审批确认后落库，
 * 且只写 data.quotes（不碰 logs / ings.stock / ings.avg / recv）。
 */
import { useState } from 'react'
import { Alert, Button, Modal, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  previewQuoteImport,
  submitQuoteImport,
  type QuoteImportItem,
  type QuoteImportPreview,
  type QuoteImportRow,
} from '../../api/quoteImport'

interface Props {
  open: boolean
  onClose: () => void
}

function readJsonFile(file: File): Promise<QuoteImportItem[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.onload = () => {
      try {
        const text = String(reader.result || '')
        const parsed = JSON.parse(text)
        const items: unknown = Array.isArray(parsed) ? parsed : parsed && (parsed as { items?: unknown }).items
        if (!Array.isArray(items)) throw new Error('JSON 顶层应为数组，或含 {items:[...]}')
        resolve(items as QuoteImportItem[])
      } catch (e) {
        reject(new Error('JSON 解析失败：' + (e as { message?: string }).message))
      }
    }
    reader.readAsText(file)
  })
}

const ROW_COLUMNS: ColumnsType<QuoteImportRow> = [
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (s: QuoteImportRow['status']) =>
      s === 'append' ? <Tag color="green">将追加</Tag> : s === 'skipped' ? <Tag color="orange">跳过</Tag> : <Tag color="red">非法</Tag>,
  },
  { title: '原料', dataIndex: 'ing', render: (v) => (v == null || v === '' ? '-' : String(v)) },
  { title: '供应商', dataIndex: 'src', render: (v) => (v == null || v === '' ? '-' : String(v)) },
  { title: '价格', dataIndex: 'price' },
  { title: '原因', dataIndex: 'reason', render: (v) => v || '-' },
]

export default function QuoteImportModal({ open, onClose }: Props) {
  const [fileName, setFileName] = useState('')
  const [items, setItems] = useState<QuoteImportItem[]>([])
  const [preview, setPreview] = useState<QuoteImportPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const reset = () => {
    setFileName('')
    setItems([])
    setPreview(null)
    setErr(null)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setErr(null)
    try {
      const parsed = await readJsonFile(file)
      setFileName(file.name)
      setItems(parsed)
      const p = await previewQuoteImport(parsed)
      setPreview(p)
    } catch (e) {
      setErr((e as { message?: string }).message || '预览失败')
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const onConfirm = async () => {
    if (!items.length) return
    setBusy(true)
    try {
      await submitQuoteImport(items)
      message.success('报价导入已入队 → 请到审批中心确认执行')
      reset()
      onClose()
    } catch (e) {
      const e2 = e as { response?: { data?: { error?: string } }; message?: string }
      message.error(e2.response?.data?.error || e2.message || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = !!preview && preview.append > 0

  return (
    <Modal
      title="导入比价结果（W2-04）"
      open={open}
      onCancel={() => {
        reset()
        onClose()
      }}
      width={720}
      footer={[
        <Button key="close" onClick={() => { reset(); onClose() }}>
          取消
        </Button>,
        <Button
          key="ok"
          type="primary"
          disabled={!canSubmit || busy}
          loading={busy}
          onClick={onConfirm}
        >
          确认导入（{preview ? preview.append : 0} 条）
        </Button>,
      ]}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="导入只写 data.quotes（不碰库存/流水/进货单）；同原料不同价并存，完全相同的行自动跳过，单位换算非 1 的原料跳过。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <input
          type="file"
          accept="application/json,.json"
          onChange={(e) => onFile(e.target.files?.[0])}
          disabled={busy}
        />
        {fileName && <Typography.Text type="secondary">{fileName}</Typography.Text>}
      </Space>

      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}

      {preview && (
        <>
          <Space style={{ marginBottom: 12 }} wrap>
            <Tag color="green">将追加 {preview.append}</Tag>
            <Tag color="orange">跳过 {preview.skipped}</Tag>
            <Tag color="red">非法 {preview.invalid}</Tag>
          </Space>
          <Table<QuoteImportRow>
            rowKey={(_, i) => String(i)}
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={preview.rows}
            columns={ROW_COLUMNS}
          />
        </>
      )}
    </Modal>
  )
}
