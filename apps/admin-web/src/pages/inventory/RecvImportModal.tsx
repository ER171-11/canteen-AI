import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import dayjs, { type Dayjs } from 'dayjs'
import { postAction } from '../../api'
import { previewRecvImport } from '../../api/recvImport'
import type { RecvImportGroup, RecvImportLine, RecvImportPreview } from '../../api/recvImport'
import { useAuthStore } from '../../store/auth'
import { downloadRecvTemplate } from './recvTemplate'
import { fmt } from './settle/data'

/**
 * FP-RECV-02 进货单批量导入 / FP-RECV-03 下载导入模板。
 *
 * 移植自旧版：readImportFile(:3547) → previewRecvImport(:3591) → commitRecvImport(:3650)，
 * 差异是把「解析」从浏览器 JS 挪到 BFF（lib/recv_import.js，纯计算零写），
 * 云端与 App 共用同一套解析口径。
 *
 * 红线（与 ADR-004 一致）：
 *   · **预览 = 只读**：previewRecvImport 不写文件、不入队，可反复点。
 *   · **提交 = 一个动作**：整批只投一条 `recv.import`，批内原子；确认前账面零变化。
 *   · 解析失败 / 不支持的格式一律**显式报错**，不静默丢弃任何一行（红线⑥）。
 *
 * 与旧版的关系（都写在界面上）：
 *   ① 未匹配原料**回归旧版行为：自动建档**（createIngFromImport :2806；2026-10-12 撤销原「不代建」偏离），
 *      但不像旧版那样把不确定的单位/分类静默写进主数据 —— 新料建成「待完善草稿」（pending:true），
 *      导入不阻断，由门店到「原料档案 → 待完善」补全信息并「确认转正」。
 *   ② 旧版二进制 .xls（BIFF8）**不支持**，见界面提示（先另存为 .xlsx / CSV）。
 *   ③ 旧版「手动指定列」(:3465) 未移植：表头靠别名自动识别，识别不了会明确报错并要求改列名。
 *   ④ 导入产生的是「 orders 之外的新 JH 单」，不会回写采购单收货进度（同采购管理页欠账）。
 */

/** 支持格式清单（界面明示，红线⑥ 不得静默降级） */
const SUPPORTED_FORMATS = [
  '.xlsx（Excel 2007+，二维规范表）',
  '.csv / .tsv（UTF-8 或 GBK，逗号/制表符自动识别）',
  '.json（[{supplier,date,lines:[…]}] 或 {pos:[…]}）',
  '.html / .htm（供应商系统导出的「伪 .xls」网页表格）',
]

const UNSUPPORTED = '暂不支持：旧版二进制 .xls（Excel 97-2003），请先另存为 .xlsx 或 CSV'

/** 必填列（界面明示，取自 BFF 侧 IMP_PO_DEFS 的 req 标记列） */
const REQUIRED_COLS = '必填列：品名/原料名称 + 数量（或 实收数/下单数）+ 单价'

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

export interface RecvImportModalProps {
  open: boolean
  onClose: () => void
  /** 入队成功后回调（父页刷新列表） */
  onQueued?: () => void
}

const lineCols: ColumnsType<RecvImportLine> = [
  {
    title: '原料',
    dataIndex: 'name',
    render: (v: string, r) => (
      <Space size={4}>
        <span>{v}</span>
        {r.isNew ? <Tag color="orange">新增</Tag> : null}
      </Space>
    ),
  },
  { title: '订购量', dataIndex: 'qty', width: 90, align: 'right' },
  {
    title: '单价',
    dataIndex: 'price',
    width: 90,
    align: 'right',
    render: (v: number) => `¥${fmt(Number(v) || 0)}`,
  },
  {
    title: '金额',
    dataIndex: 'amount',
    width: 100,
    align: 'right',
    render: (v: number) => `¥${fmt(Number(v) || 0)}`,
  },
]

export default function RecvImportModal({ open, onClose, onQueued }: RecvImportModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<RecvImportPreview | null>(null)
  /* 单张时可改抬头（对应旧版预览弹窗里的 metaForm :3624-3628） */
  const [supplier, setSupplier] = useState('')
  const [date, setDate] = useState<Dayjs>(dayjs())
  const [note, setNote] = useState('')
  const [markPaid, setMarkPaid] = useState(false)

  const groups = useMemo<RecvImportGroup[]>(() => preview?.groups ?? [], [preview])

  const reset = () => {
    setFileName('')
    setPreview(null)
    setBusy(false)
    setMarkPaid(false)
    setSupplier('')
    setNote('')
    setDate(dayjs())
  }

  const handleFile = async (file: File) => {
    setBusy(true)
    setPreview(null)
    try {
      const contentBase64 = await readAsBase64(file)
      const pv = await previewRecvImport({ fileName: file.name, contentBase64 })
      setFileName(file.name)
      setPreview(pv)
      setSupplier(pv.groups[0]?.supplier ?? '')
      setDate(pv.groups[0]?.date ? dayjs(pv.groups[0].date) : dayjs())
      setNote(pv.groups[0]?.note ?? '')
      message.success(`已预览：${pv.groups.length} 张单据 / ${pv.totalLines} 行`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '预览失败（文件无法识别）')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (!preview || !groups.length) return
    setBusy(true)
    /* 新增原料的分类（预览给出，供执行器建档时写入 cat；缺省执行器兜底「其他」） */
    const catOf = new Map((preview.newIngs ?? []).map((n) => [n.name, n.cat]))
    try {
      await postAction({
        type: 'recv.import',
        operator: role ?? account ?? 'admin',
        payload: {
          /* 整批一个动作：批内的 N 张单据一次性进队列，批末由执行器统一 rebuildStock（ADR-004 §2.4） */
          docs: groups.map((g) => ({
            supplier: preview.single ? String(supplier).trim() : g.supplier,
            date: preview.single ? date.format('YYYY-MM-DD') : g.date,
            note: preview.single ? note.trim() : g.note,
            lines: g.lines.map((l) => ({
              ingId: l.ingId,
              name: l.name,
              qty: l.qty,
              price: l.price,
              unit: l.unit,
              cat: catOf.get(l.name),
            })),
          })),
          markPaid,
          source: 'admin-web/inventory/inbound',
        },
      })
      message.success('批量导入已入队 → 请到审批中心确认（确认后店内库存/欠款才变）')
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

  return (
    <Modal
      title="批量导入进货单"
      open={open}
      width={860}
      confirmLoading={busy}
      okText={preview ? `确认导入 ${groups.length} 张` : '确认导入'}
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
          <Button onClick={downloadRecvTemplate}>下载导入模板</Button>
          {fileName ? <Typography.Text type="secondary">{fileName}</Typography.Text> : null}
        </Space>

        <Alert
          type="info"
          showIcon
          message={
            <span>
              支持格式：{SUPPORTED_FORMATS.join(' / ')}
            </span>
          }
          description={
            <div style={{ fontSize: 12 }}>
              <div>{REQUIRED_COLS}（同义词自动识别，如「商品名称」「实收数」「采购单价」）</div>
              <div style={{ color: '#cf1322' }}>{UNSUPPORTED}</div>
              <div>
                表内若有「供应商/日期」列，会按「供应商+日期」自动拆成多张 JH 单；没有则全部并成 1 张。
              </div>
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
              <Tag>单据 {preview.groups.length} 张</Tag>
              <Tag>明细 {preview.totalLines} 行</Tag>
              <Tag color="green">合计应付 ¥{fmt(preview.totalAmount)}</Tag>
              {preview.bad > 0 ? <Tag color="red">无效行剔除 {preview.bad} 行</Tag> : null}
              {preview.skipped > 0 ? (
                <Tag color="orange">实收数为「×/未收」跳过 {preview.skipped} 行</Tag>
              ) : null}
              {preview.unmatched.length > 0 ? (
                <Tag color="orange">
                  新增原料 {preview.unmatched.length} 种（自动建档 · 待完善）
                </Tag>
              ) : null}
            </Space>

            {preview.unmatched.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={
                  <span>
                    以下原料在「原料档案」中不存在，将<b>自动建档为「待完善」草稿</b>（不阻塞本单导入）：
                    <b>{preview.unmatched.join('、')}</b>
                  </span>
                }
                description="导入后请到「原料档案 → 待完善」补全分类/库存单位等信息并点「确认转正」（原料档案页顶部会显示待完善 N 项）"
              />
            ) : null}

            {preview.single ? (
              <Space wrap size="middle">
                <span>
                  供应商
                  <Input
                    value={supplier}
                    onChange={(e) => setSupplier(e.target.value)}
                    style={{ width: 220, marginLeft: 8 }}
                    placeholder="未指定供应商"
                  />
                </span>
                <span>
                  单据日期
                  <DatePicker
                    value={date}
                    allowClear={false}
                    style={{ marginLeft: 8 }}
                    onChange={(d) => d && setDate(d)}
                  />
                </span>
                <span>
                  备注 / 单据号
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    style={{ width: 200, marginLeft: 8 }}
                  />
                </span>
              </Space>
            ) : null}

            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              {groups.map((g, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <Typography.Text strong>
                    {g.date} · {g.supplier || '未指定供应商'}
                  </Typography.Text>
                  {g.note ? <Typography.Text type="secondary"> · {g.note}</Typography.Text> : null}
                  <Typography.Text type="secondary"> · 应付 ¥{fmt(g.payable)}</Typography.Text>
                  <Table<RecvImportLine>
                    size="small"
                    rowKey={(r, ri) => `${r.ingId}-${ri ?? 0}`}
                    columns={lineCols}
                    dataSource={g.lines}
                    pagination={false}
                  />
                </div>
              ))}
            </div>

            <Checkbox checked={markPaid} onChange={(e) => setMarkPaid(e.target.checked)}>
              按应付全额登记付款（默认挂账，可后续补付）
            </Checkbox>

            <Alert
              type="warning"
              showIcon
              message="提交后进入审批中心，确认后由店内消费器一次性重算库存与欠款"
              description={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已知差异：① 未匹配原料自动建档为「待完善」草稿（与旧版一致，导入不阻断）；
                  ② 旧版二进制 .xls 不支持；
                  ③ 无「手动指定列」，表头靠别名自动识别；④ 不回写采购单收货进度。
                </Typography.Text>
              }
            />
          </>
        ) : null}
      </Space>
    </Modal>
  )
}
