import { useEffect, useMemo, useState } from 'react'
import { Button, DatePicker, Input, Modal, Space, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { InventoryDoc, SettleTemplate } from '../../../api/types'
import dayjs, { type Dayjs } from 'dayjs'
import { buildSettleData, fmt, r2, today, type IngLookup } from './data'
import { download } from './download'
import { buildSettleBatchHtml, printHtmlDoc, type SettleOpts } from './html'
import { exportSettleBatchCsv, exportSettleBatchHtmlFileName } from './export'
import { docDebt, docPaid } from '../utils'
import { rk } from '../../../utils/rowKey'

/**
 * 批量生成结算单弹窗（移植自旧版 openSettleBatch :2548-2606）。
 *
 * ⚠️ 批量语义（modules/结算单.md §4 ADR，用户已确认）：
 *   **多份单据打包输出，而非合并成一张** —— N 个 .sheet 一次打印成一个连续 PDF，
 *   或合并为一个 CSV（同一个文件里顺序堆叠 N 张单）。**不做 zip 打包。**
 * 只读输出层：本弹窗不发起任何写请求。
 */
export interface SettleBatchModalProps {
  open: boolean
  /** 候选单据（调用方按当前筛选传入） */
  list: InventoryDoc[]
  tpl: SettleTemplate
  lookup: IngLookup
  onClose: () => void
  /** P2-a 接入：N 张合一个 PDF */
  onExportPdf?: (list: InventoryDoc[], tpl: SettleTemplate, opts: SettleOpts) => Promise<void> | void
}

export default function SettleBatchModal({
  open,
  list,
  tpl,
  lookup,
  onClose,
  onExportPdf,
}: SettleBatchModalProps) {
  const [reportDate, setReportDate] = useState<Dayjs>(dayjs())
  const [purpose, setPurpose] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setReportDate(dayjs())
    setPurpose(tpl.usePurpose || '采购货款')
    setSelected(list.map((d) => String(d.id ?? d.no ?? '')))
  }, [open, tpl.usePurpose, list])

  const opts: SettleOpts = useMemo(
    () => ({
      reportDate: reportDate ? reportDate.format('YYYY-MM-DD') : today(),
      purpose: purpose.trim() || tpl.usePurpose || '采购货款',
    }),
    [reportDate, purpose, tpl.usePurpose],
  )

  const keyOf = (d: InventoryDoc) => String(d.id ?? d.no ?? '')

  const selDocs = useMemo(() => {
    const set = new Set(selected)
    return list.filter((d) => set.has(keyOf(d)))
  }, [list, selected])

  const sum = useMemo(() => {
    const pay = r2(selDocs.reduce((a, d) => a + (Number(d.payable) || 0), 0))
    const debt = r2(selDocs.reduce((a, d) => a + docDebt(d), 0))
    return { pay, debt }
  }, [selDocs])

  const columns: ColumnsType<InventoryDoc> = [
    { title: '单号', dataIndex: 'no', width: 150, render: (v) => v ?? '-' },
    { title: '日期', dataIndex: 'date', width: 110 },
    { title: '供应商', dataIndex: 'supplier', ellipsis: true },
    {
      title: '明细',
      key: 'count',
      width: 70,
      align: 'right',
      render: (_, r) => buildSettleData(r, lookup).count,
    },
    {
      title: '应付',
      dataIndex: 'payable',
      width: 100,
      align: 'right',
      render: (v) => (v == null ? '-' : `¥${fmt(v)}`),
    },
    {
      title: '已付',
      key: 'paid',
      width: 100,
      align: 'right',
      render: (_, r) => `¥${fmt(docPaid(r))}`,
    },
    {
      title: '欠款',
      key: 'debt',
      width: 100,
      align: 'right',
      render: (_, r) => {
        const d = docDebt(r)
        return d > 0.01 ? <span style={{ color: '#cf1322' }}>¥{fmt(d)}</span> : <Tag>已结清</Tag>
      },
    },
  ]

  const guard = (): boolean => {
    if (!selDocs.length) {
      message.warning('请先勾选进货单')
      return false
    }
    return true
  }

  const doPrint = () => {
    if (!guard()) return
    printHtmlDoc(buildSettleBatchHtml(selDocs, tpl, lookup, opts))
  }

  const doHtml = () => {
    if (!guard()) return
    const name = exportSettleBatchHtmlFileName(opts.reportDate || today(), selDocs.length)
    download(name, buildSettleBatchHtml(selDocs, tpl, lookup, opts), 'text/html')
    message.success(`已导出电子版（${selDocs.length} 张合一个文件）：${name}`)
  }

  const doCsv = () => {
    if (!guard()) return
    const name = exportSettleBatchCsv(selDocs, tpl, lookup, opts)
    message.success(`已导出合并 CSV（${selDocs.length} 张）：${name}`)
  }

  const doPdf = async () => {
    if (!onExportPdf || !guard()) return
    setBusy(true)
    try {
      await onExportPdf(selDocs, tpl, opts)
    } catch (e: unknown) {
      message.error('生成 PDF 失败：' + ((e as Error)?.message || e) + '（可改用「打印选中」）')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="批量生成结算单"
      open={open}
      onCancel={onClose}
      width={900}
      footer={
        <Space wrap>
          <Button onClick={onClose}>取消</Button>
          {onExportPdf && (
            <Button type="primary" loading={busy} onClick={doPdf}>
              导出选中 · PDF
            </Button>
          )}
          <Button onClick={doHtml}>导出选中 · 电子版</Button>
          <Button onClick={doCsv}>导出选中 · 合并 CSV</Button>
          <Button onClick={doPrint}>打印选中 · 连续 PDF</Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        {tpl.restName || '熊猫五福餐厅'} · {tpl.title} · 共 {list.length} 张进货单
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

      <Space wrap style={{ margin: '8px 0' }}>
        <Button size="small" onClick={() => setSelected(list.map(keyOf))}>
          全选
        </Button>
        <Button size="small" onClick={() => setSelected([])}>
          全不选
        </Button>
        <Button
          size="small"
          onClick={() => setSelected(list.filter((d) => docDebt(d) > 0.01).map(keyOf))}
        >
          仅选有欠款
        </Button>
        <Typography.Text type="secondary">
          已选 {selDocs.length} / {list.length} 张 · 应付合计 ¥{fmt(sum.pay)} · 欠款 ¥
          {fmt(sum.debt)}
        </Typography.Text>
      </Space>

      <Table<InventoryDoc>
        rowKey={rk}
        size="small"
        columns={columns}
        dataSource={list}
        pagination={false}
        scroll={{ y: 320 }}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (keys) => setSelected(keys as string[]),
        }}
      />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
        「导出 PDF」会把勾选的 N 张合并成<b>一个 PDF 文件</b>（每张一页，含多页明细时自动续页），
        可直接发微信传阅；「电子版 HTML」同理，但更适合自己留档。
      </Typography.Paragraph>
    </Modal>
  )
}
