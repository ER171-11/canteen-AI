import type { InventoryDoc, SettleTemplate } from '../../../api/types'
import { buildSettleData, csv, numToCn, r2, settleNo, today, type IngLookup } from './data'
import { download } from './download'
import { DEFAULT_REST_NAME } from './template'
import type { SettleOpts } from './html'

/**
 * 结算单 CSV 导出（UTF-8 BOM，Excel 直接打开）。
 * 移植自旧版 exportSettleCsv(:2464-2485) 与 exportSettleBatchCsv(:2524-2546)。
 * 只读输出：不写库。
 */

function restOf(tpl: SettleTemplate): string {
  return tpl.restName || DEFAULT_REST_NAME
}

/** 单张结算单 CSV */
export function exportSettleCsv(
  doc: InventoryDoc,
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
): string {
  const d = buildSettleData(doc, lookup)
  const o = opts || {}
  const reportDate = o.reportDate || today()
  const purpose = o.purpose || tpl.usePurpose || '采购货款'
  const restName = restOf(tpl)
  const rows: Array<Array<unknown>> = []
  rows.push([restName + ' ' + tpl.title])
  rows.push(['单据编号', settleNo(doc), '报表日期', reportDate, '付款方式', doc.method || ''])
  rows.push(['进货单号', doc.no, '进货日期', doc.date, '明细项数', d.count])
  rows.push(['收款单位', doc.supplier, '支出用途', purpose])
  if (tpl.payeeName || tpl.payeeBank || tpl.payeeAccount) {
    rows.push(['开户行', tpl.payeeBank || '', '银行账号', tpl.payeeAccount || ''])
  }
  rows.push([])
  rows.push(['序号', '品名', '数量', '单位', '单价(元)', '金额(元)'])
  d.lines.forEach((l) => rows.push([l.no, l.name, l.qty, l.buyUnit, l.price, l.amount]))
  rows.push(['合计', '', '', '', '', d.payable])
  rows.push(['小写合计', '¥' + d.payable.toFixed(2)])
  rows.push(['人民币大写', numToCn(d.payable)])
  rows.push(['应付全额', d.payable, '已付', d.paid, '欠款', d.debt])
  rows.push([])
  rows.push(['签字栏', (tpl.subjects || []).join(' / ')])
  const name = `结算单_${doc.no}.csv`
  download(name, csv(rows), 'text/csv')
  return name
}

/**
 * 批量：合并为**一个** CSV，同一个文件里顺序堆叠 N 张单
 * （不是 Excel 多 Sheet —— 旧版无 XLSX 库，见 modules/结算单.md §5 已知限制）。
 */
export function exportSettleBatchCsv(
  list: InventoryDoc[],
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
): string {
  const o = opts || {}
  const reportDate = o.reportDate || today()
  const purpose = o.purpose || tpl.usePurpose || '采购货款'
  const restName = restOf(tpl)
  const rows: Array<Array<unknown>> = []
  rows.push([restName + ' ' + tpl.title + '（批量 ' + list.length + ' 张）'])
  rows.push(['报表日期', reportDate, '支出用途', purpose])
  rows.push([
    '应付合计',
    r2(list.reduce((a, p) => a + (Number(p.payable) || 0), 0)),
    '欠款合计',
    r2(list.reduce((a, p) => a + buildSettleData(p, lookup).debt, 0)),
  ])
  list.forEach((po, i) => {
    const d = buildSettleData(po, lookup)
    rows.push([])
    rows.push([
      `第 ${i + 1}/${list.length} 张`,
      settleNo(po),
      '进货单号',
      po.no,
      '进货日期',
      po.date,
      '付款方式',
      po.method || '',
    ])
    rows.push(['收款单位', po.supplier, '支出用途', purpose])
    rows.push(['序号', '品名', '数量', '单位', '单价(元)', '金额(元)'])
    d.lines.forEach((l) => rows.push([l.no, l.name, l.qty, l.buyUnit, l.price, l.amount]))
    rows.push(['合计', '', '', '', '', d.payable])
    rows.push(['人民币大写', numToCn(d.payable)])
    rows.push(['应付全额', d.payable, '已付', d.paid, '欠款', d.debt])
    rows.push(['签字栏', (tpl.subjects || []).join(' / ')])
  })
  const name = `结算单_批量_${reportDate}_${list.length}张.csv`
  download(name, csv(rows), 'text/csv')
  return name
}

/** 电子版 HTML：单文件自包含，可微信发送，接收方打开后 Ctrl+P 仍可转 PDF */
export function exportSettleHtmlFileName(doc: InventoryDoc, reportDate: string): string {
  return `结算单_${settleNo(doc)}_${reportDate}.html`
}

export function exportSettleBatchHtmlFileName(reportDate: string, n: number): string {
  return `结算单_批量_${reportDate}_${n}张.html`
}
