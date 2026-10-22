import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { postAction } from '../../api'
import {
  SALE_SRCS,
  fetchSaleAlias,
  previewSaleImport,
} from '../../api/saleImport'
import type { SaleImportDoc, SaleImportLine, SaleImportPreview, SaleDishOption } from '../../api/saleImport'
import { useAuthStore } from '../../store/auth'
import { fmt } from '../inventory/settle/data'

/**
 * FP-SALE-03 平台销售数据导入（预览只读 → 提交一个 sale.import 动作）。
 *
 * 与 RecvImportModal 同型：解析口径唯一出口在 BFF 侧（lib/sales_import.js），
 * 前端只传「原始文件 + 人工菜名映射 + 来源/结算」，不本地算金额（避免口径漂移）。
 *
 * 差异点（销售导入特有）：
 *   · 平台菜名匹配不到的「未匹配菜名」需人工映射到本店菜品（三级匹配：别名→精确→归一化都失败时才出现）；
 *     映射一次会写回菜名映射表（data.dishAlias），后续导入同一菜名自动命中。
 *   · 支持「明细模式（按订单号拆单）/ 汇总模式（按日期汇总）」，由列是否含「订单号」自动判定。
 */
const SUPPORTED_FORMATS = [
  '.xlsx（Excel 2007+，二维规范表）',
  '.csv / .tsv（UTF-8 或 GBK）',
  '.json（[{dish,qty,date,…}] 或 {sales/orders/items:[…]}）',
  '.html / .htm（平台导出的网页表格）',
]
const REQUIRED_COLS = '必填列：菜品名称 + 数量；金额口径按「原价/用户实付/商家实收/平台服务费/优惠」自动判定 A–E'

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = () => reject(fr.error || new Error('read failed'))
    fr.readAsDataURL(file)
  })
}

export interface SaleImportModalProps {
  open: boolean
  onClose: () => void
  onQueued?: () => void
}

const lineCols: ColumnsType<SaleImportLine> = [
  {
    title: '菜品',
    dataIndex: 'dishName',
    render: (v: string, r) => (
      <Space size={4}>
        <span>{v}</span>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          ({r.dish})
        </Typography.Text>
      </Space>
    ),
  },
  { title: '数量', dataIndex: 'qty', width: 80, align: 'right' },
  { title: '单价', dataIndex: 'price', width: 90, align: 'right', render: (v: number) => `¥${fmt(Number(v) || 0)}` },
]

export default function SaleImportModal({ open, onClose, onQueued }: SaleImportModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const [contentBase64, setContentBase64] = useState('')
  const [preview, setPreview] = useState<SaleImportPreview | null>(null)
  const [dishOptions, setDishOptions] = useState<SaleDishOption[]>([])
  /* 未匹配菜名 → 本店菜品 id（提交时写回映射表） */
  const [sel, setSel] = useState<Record<string, string>>({})
  const [src, setSrc] = useState('mt')
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!open) return
    /* 打开时拉在售菜品下拉（供人工映射用） */
    fetchSaleAlias()
      .then((r) => setDishOptions(r.onDishes ?? []))
      .catch(() => setDishOptions([]))
  }, [open])

  const reset = () => {
    setFileName('')
    setContentBase64('')
    setPreview(null)
    setSel({})
    setSrc('mt')
    setSettled(false)
    setBusy(false)
  }

  const handleFile = async (file: File) => {
    setBusy(true)
    setPreview(null)
    setSel({})
    try {
      const b64 = await readAsBase64(file)
      const pv = await previewSaleImport({ fileName: file.name, contentBase64: b64 })
      setFileName(file.name)
      setContentBase64(b64)
      setPreview(pv)
      if (pv.unmatched.length) {
        message.warning(`有 ${pv.unmatched.length} 个菜名未匹配，请在下方指定本店菜品`)
      } else {
        message.success(`已预览：${pv.totalDocs} 张单据 / ${pv.totalRows} 行`)
      }
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '预览失败（文件无法识别）')
    } finally {
      setBusy(false)
    }
  }

  const mappedCount = useMemo(() => Object.keys(sel).length, [sel])
  const allMapped = preview ? mappedCount >= preview.unmatched.length : true

  const submit = async () => {
    if (!preview || !contentBase64) return
    setBusy(true)
    try {
      await postAction({
        type: 'sale.import',
        operator: role ?? account ?? 'admin',
        payload: {
          /* 整批一个动作：批内 N 张销售单一次性进队列（ADR-004 §2.4 批内原子） */
          contentBase64,
          fileName,
          mode: preview.mode,
          sel,
          src,
          settled,
          source: 'admin-web/dinein/sales/import',
        },
      })
      message.success('销售数据导入已入队 → 请到审批中心确认')
      onQueued?.()
      reset()
      onClose()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const dishOpts = useMemo(() => dishOptions.map((d) => ({ label: d.name, value: d.id })), [dishOptions])

  return (
    <Modal
      title="导入平台销售数据"
      open={open}
      width={900}
      confirmLoading={busy}
      okText={preview ? `确认导入 ${preview.totalDocs} 张` : '确认导入'}
      okButtonProps={{ disabled: !preview || busy }}
      onOk={submit}
      onCancel={() => {
        reset()
        onClose()
      }}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space wrap>
          <Upload
            accept=".xlsx,.xls,.csv,.tsv,.json,.htm,.html"
            showUploadList={false}
            beforeUpload={(file) => {
              void handleFile(file as File)
              return false
            }}
          >
            <Button type="primary" loading={busy}>
              选择文件
            </Button>
          </Upload>
          {fileName ? <Typography.Text type="secondary">{fileName}</Typography.Text> : null}
        </Space>

        <Alert
          type="info"
          showIcon
          message={<span>支持格式：{SUPPORTED_FORMATS.join(' / ')}</span>}
          description={
            <div style={{ fontSize: 12 }}>
              <div>{REQUIRED_COLS}</div>
              <div style={{ color: '#cf1322' }}>暂不支持旧版二进制 .xls（Excel 97-2003），请另存为 .xlsx 或 CSV</div>
              <div>含「订单号」列 → 按订单号拆单（明细模式）；不含 → 按日期汇总（汇总模式）。</div>
            </div>
          }
        />

        {!preview && !busy ? (
          <Empty description="先选一个文件：会先出预览，确认后才会入队（预览不改动任何数据）" />
        ) : null}

        {preview ? (
          <>
            <Space wrap size="middle">
              <Tag color="blue">识别格式：{preview.format}</Tag>
              <Tag color={preview.mode === 'detail' ? 'geekblue' : 'default'}>
                {preview.mode === 'detail' ? '明细模式（按订单号）' : '汇总模式（按日期）'}
              </Tag>
              <Tag>单据 {preview.totalDocs} 张</Tag>
              <Tag>明细 {preview.totalRows} 行</Tag>
              <Tag color="green">应收合计 ¥{fmt(preview.totalReceivable)}</Tag>
              {preview.unmapped > 0 ? <Tag color="orange">未匹配 {preview.unmapped} 行</Tag> : null}
              {preview.skipped > 0 ? <Tag color="red">跳过 {preview.skipped} 行</Tag> : null}
            </Space>

            {preview.unmatched.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message="以下平台菜名匹配不到本店「在售菜品」，请指定本店菜品（指定后会写入菜名映射，下次自动匹配）"
                description={
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {preview.unmatched.map((name) => (
                      <Space key={name} wrap>
                        <Typography.Text strong>{name}</Typography.Text>
                        <span>→</span>
                        <Select
                          style={{ width: 240 }}
                          placeholder="选择本店菜品（不选则该菜名行被跳过）"
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          options={dishOpts}
                          value={sel[name]}
                          onChange={(v) => setSel((prev) => ({ ...prev, [name]: v as string }))}
                        />
                      </Space>
                    ))}
                  </Space>
                }
              />
            ) : null}

            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {preview.docs.map((d: SaleImportDoc, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <Typography.Text strong>
                    {d.date}
                    {d.srcNo ? ` · ${d.srcNo}` : ''}
                  </Typography.Text>
                  <Typography.Text type="secondary"> · 应收 ¥{fmt(d.receivable)}</Typography.Text>
                  {d.amtMode ? <Tag style={{ marginLeft: 8 }}>口径 {d.amtMode}</Tag> : null}
                  <Table<SaleImportLine>
                    size="small"
                    rowKey={(r, ri) => `${r.dish}-${ri ?? 0}`}
                    columns={lineCols}
                    dataSource={d.lines}
                    pagination={false}
                  />
                </div>
              ))}
            </div>

            <Space wrap size="middle">
              <span>
                来源平台
                <Select
                  style={{ width: 140, marginLeft: 8 }}
                  value={src}
                  onChange={(v) => setSrc(v as string)}
                  options={SALE_SRCS.map((s) => ({ label: s.name, value: s.key }))}
                />
              </span>
              <Checkbox checked={settled} onChange={(e) => setSettled(e.target.checked)}>
                按应收全额登记「平台结算」（默认挂账）
              </Checkbox>
            </Space>

            <Alert
              type="warning"
              showIcon
              message="提交后进入审批中心，确认后由店内消费器写入销售单"
              description={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已知边界：① 美团数据格式尚不确定，靠列名别名自动识别，识别不了会明确报错；
                  ② 未映射的菜名行会被跳过（不静默改金额）；③ 金额口径 A–E 由系统按列自动判定，可在「批次管理」里事后重算。
                </Typography.Text>
              }
            />
          </>
        ) : null}

        {preview && !allMapped ? (
          <Typography.Text type="warning">还有 {preview.unmatched.length - mappedCount} 个未匹配菜名未指定，其对应行将被跳过。</Typography.Text>
        ) : null}
      </Space>
    </Modal>
  )
}
