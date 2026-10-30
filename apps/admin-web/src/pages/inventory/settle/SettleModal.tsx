import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, DatePicker, Input, Modal, Space, Typography, message } from 'antd'
import type { InventoryDoc, SettleTemplate } from '../../../api/types'
import dayjs, { type Dayjs } from 'dayjs'
import { buildSettleData, fmt, numToCn, pendingNotice, settleNo, today, type IngLookup } from './data'
import { download } from './download'
import { buildSettleHtml, printHtmlDoc, type SettleOpts } from './html'
import { exportSettleCsv, exportSettleHtmlFileName } from './export'

/**
 * 单张结算单生成弹窗（移植自旧版 openSettle :2486-2522）。
 * 只读输出层：本弹窗不发起任何写请求。
 *
 * 「导出 PDF」按钮由 onExportPdf 决定是否存在 —— P2-a 交付 PDF 引擎后才出现，
 * 避免出现点了没反应的死按钮。
 */
export interface SettleModalProps {
  open: boolean
  doc?: InventoryDoc | null
  tpl: SettleTemplate
  lookup: IngLookup
  onClose: () => void
  /** P2-a 接入：导出真·PDF 字节流（微信可传） */
  onExportPdf?: (doc: InventoryDoc, tpl: SettleTemplate, opts: SettleOpts) => Promise<void> | void
}

export default function SettleModal({
  open,
  doc,
  tpl,
  lookup,
  onClose,
  onExportPdf,
}: SettleModalProps) {
  const [reportDate, setReportDate] = useState<Dayjs>(dayjs())
  const [purpose, setPurpose] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setReportDate(dayjs())
    setPurpose(tpl.usePurpose || '采购货款')
  }, [open, tpl.usePurpose])

  const opts: SettleOpts = useMemo(
    () => ({
      reportDate: reportDate ? reportDate.format('YYYY-MM-DD') : today(),
      purpose: purpose.trim() || tpl.usePurpose || '采购货款',
    }),
    [reportDate, purpose, tpl.usePurpose],
  )

  const data = useMemo(
    () => (doc ? buildSettleData(doc, lookup) : null),
    [doc, lookup],
  )

  if (!doc || !data) return null

  const doPrint = () => {
    printHtmlDoc(buildSettleHtml(doc, tpl, lookup, opts))
  }

  const doHtml = () => {
    const name = exportSettleHtmlFileName(doc, opts.reportDate || today())
    download(name, buildSettleHtml(doc, tpl, lookup, opts), 'text/html')
    message.success(`已导出电子版 ${name}`)
  }

  const doCsv = () => {
    const name = exportSettleCsv(doc, tpl, lookup, opts)
    message.success(`已导出 ${name}（Excel 可直接打开）`)
  }

  const doPdf = async () => {
    if (!onExportPdf) return
    setBusy(true)
    try {
      await onExportPdf(doc, tpl, opts)
    } catch (e: unknown) {
      message.error('生成 PDF 失败：' + ((e as Error)?.message || e) + '（可改用「打印 / 另存为 PDF」）')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`生成结算单 · ${doc.no ?? doc.id ?? ''}`}
      open={open}
      onCancel={onClose}
      width={760}
      footer={
        <Space wrap>
          <Button onClick={onClose}>取消</Button>
          {onExportPdf && (
            <Button type="primary" loading={busy} onClick={doPdf}>
              导出 PDF（微信可传）
            </Button>
          )}
          <Button onClick={doHtml}>导出电子版（HTML）</Button>
          <Button onClick={doCsv}>导出 Excel（CSV）</Button>
          <Button onClick={doPrint}>打印 / 另存为 PDF</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        {tpl.restName || '熊猫五福餐厅'} · {tpl.title} · 数据来源：进货入库模块（只读）
      </Typography.Paragraph>

      <Space wrap size="middle" style={{ marginBottom: 12 }}>
        <span>
          报表日期
          <DatePicker
            value={reportDate}
            allowClear={false}
            style={{ marginLeft: 8 }}
            onChange={(d) => d && setReportDate(d)}
          />
        </span>
        <span>
          支出用途
          <Input
            value={purpose}
            style={{ width: 260, marginLeft: 8 }}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </span>
      </Space>

      {/* 待审核提示：与打印件 / PDF / CSV 同一句文案（data.ts::pendingNotice 唯一出口），
          避免「系统里看着正常、打出来多一行」的不一致 */}
      {pendingNotice(doc, data) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 10 }}
          message={pendingNotice(doc, data)}
        />
      )}
      <div>
        明细 <b>{data.count}</b> 项{'\u3000'}应付全额 <b>¥{fmt(data.payable)}</b>
        {'\u3000'}已付 ¥{fmt(data.paid)}
        {'\u3000'}欠款 ¥{fmt(data.debt)}
      </div>
      <div style={{ color: '#666' }}>
        单据编号 {settleNo(doc)}
        {'\u3000'}人民币大写：{numToCn(data.payable)}
      </div>
    </Modal>
  )
}
