import type { InventoryDoc, SettleTemplate } from '../../../api/types'
import { buildSettleData, esc, fmt, numToCn, settleNo, today, type IngLookup } from './data'
import { DEFAULT_REST_NAME } from './template'

/**
 * 结算单 HTML 版式（A4 打印 + 电子版单文件）。
 * 移植自旧版：SETTLE_CSS(:2138-2160)、settleSheet(:2162-2199)、
 * settleDocHtml(:2200)、buildSettleHtml(:2205)、buildSettleBatchHtml(:2212)、
 * printHtmlDoc(:2218)。
 *
 * ⚠️ PDF 是这套版式的**镜像实现**（settle/pdf.ts 手工坐标）。
 * 改这里必须同步改 settle/pdf.ts，否则电子版与 PDF 会漂移。
 */

/** 单张与批量共用；.sheet 负责分页，批量时每张一页 */
export const SETTLE_CSS = `@page{size:A4;margin:14mm 12mm}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Noto Sans CJK SC","Microsoft YaHei","PingFang SC",sans-serif;color:#111;font-size:12px;line-height:1.6;padding:6mm}
.ttl{text-align:center}
.ttl .rest{font-size:17px;font-weight:700;letter-spacing:2px}
.ttl .doc{font-size:15px;font-weight:700;letter-spacing:6px;margin-top:3px}
.meta{text-align:center;color:#555;font-size:11px;margin:6px 0 8px}
.head{width:100%;border-collapse:collapse;margin-bottom:8px}
.head td{border:1px solid #999;padding:5px 7px}
.head .k{background:#f2f4f7;width:78px;font-weight:700;text-align:center}
.lines{width:100%;border-collapse:collapse}
.lines th,.lines td{border:1px solid #999;padding:5px 7px;word-break:break-all}
.lines th{background:#f2f4f7;font-weight:700;text-align:center}
.lines .c{text-align:center}.lines .r{text-align:right;white-space:nowrap}
.sum{margin-top:8px;border:1px solid #999;padding:7px 9px}
.sum .big{font-size:13px;font-weight:700}
.sum .num{font-size:14px}
.sum .sub{color:#444;margin-top:3px;font-weight:400}
.signs{margin-top:24px;display:flex;justify-content:space-between;gap:14px}
.signs .sign{font-size:12.5px}
.foot{margin-top:18px;border-top:1px dashed #bbb;padding-top:6px;color:#666;font-size:10.5px;display:flex;justify-content:space-between;gap:12px}
.sheet{page-break-after:always}.sheet:last-child{page-break-after:auto}
@media print{body{padding:0}}`

export interface SettleOpts {
  /** 报表日期，默认今天 */
  reportDate?: string
  /** 支出用途，默认取模板 usePurpose */
  purpose?: string
}

export interface SettleExtra {
  index?: number
  total?: number
}

/** 单张结算单正文（不含 html/style），单张与批量共用 */
export function settleSheet(
  doc: InventoryDoc,
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
  extra?: SettleExtra,
): string {
  const d = buildSettleData(doc, lookup)
  const o = opts || {}
  const ex = extra || {}
  const reportDate = o.reportDate || today()
  const purpose = o.purpose || tpl.usePurpose || '采购货款'
  const restName = tpl.restName || DEFAULT_REST_NAME
  const meta = [
    tpl.addr ? '地址：' + esc(tpl.addr) : '',
    tpl.tel ? '电话：' + esc(tpl.tel) : '',
    tpl.taxNo ? '税号：' + esc(tpl.taxNo) : '',
  ]
    .filter(Boolean)
    .join('　　')

  const rows = d.lines
    .map(
      (l) => `<tr>
    <td class="c">${l.no}</td><td>${esc(l.name)}</td>
    <td class="c">${l.qty}</td><td class="c">${esc(l.buyUnit)}</td>
    <td class="r">${fmt(l.price)}</td><td class="r">${fmt(l.amount)}</td></tr>`,
    )
    .join('')

  const signs = (tpl.subjects || [])
    .map((x) => `<span class="sign">${esc(x)}：________________</span>`)
    .join('')

  const payeeRow =
    tpl.payeeName || tpl.payeeBank || tpl.payeeAccount
      ? `<tr><td class="k">开户行</td><td colspan="3">${esc(tpl.payeeBank || '')}</td>
     <td class="k">银行账号</td><td>${esc(tpl.payeeAccount || '')}</td></tr>`
      : ''

  const batchTag = ex.total ? `\u3000·\u3000第 ${ex.index} / ${ex.total} 张` : ''

  return `
  <div class="ttl"><div class="rest">${esc(restName)}</div><div class="doc">${esc(tpl.title)}</div></div>
  ${meta ? `<div class="meta">${meta}</div>` : '<div style="height:6px"></div>'}
  <table class="head">
    <tr><td class="k">单据编号</td><td>${esc(settleNo(doc))}</td><td class="k">报表日期</td><td>${esc(reportDate)}</td><td class="k">付款方式</td><td>${esc(doc.method || '')}</td></tr>
    <tr><td class="k">进货单号</td><td>${esc(doc.no)}</td><td class="k">进货日期</td><td>${esc(doc.date)}</td><td class="k">明细项数</td><td>${d.count} 项</td></tr>
    <tr><td class="k">收款单位</td><td colspan="3">${esc(doc.supplier)}</td><td class="k">支出用途</td><td>${esc(purpose)}</td></tr>
    ${payeeRow}
  </table>
  <table class="lines">
    <thead><tr><th style="width:42px">序号</th><th>品名</th><th style="width:70px">数量</th><th style="width:58px">单位</th><th style="width:92px">单价(元)</th><th style="width:100px">金额(元)</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="sum">
    <div class="big">小写合计：<span class="num">¥${fmt(d.payable)}</span></div>
    <div class="big">人民币大写：${numToCn(d.payable)}</div>
    <div class="sub">明细合计 ¥${fmt(d.gross)}\u3000|\u3000整单优惠 −¥${fmt(d.discount)}</div>
    <div class="sub">明细 ${d.count} 项 · 合计数量 ${fmt(d.totalQty, 3)}\u3000|\u3000应付全额 ¥${fmt(d.payable)}\u3000已付 ¥${fmt(d.paid)}\u3000欠款 ¥${fmt(d.debt)}</div>
  </div>
  <div class="signs">${signs}</div>
  <div class="foot"><span>${esc(tpl.footer || '')}</span><span>制单时间：${new Date().toLocaleString('zh-CN')}${batchTag}</span></div>`
}

export function settleDocHtml(sheets: string, docTitle: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>${esc(docTitle)}</title>
<style>${SETTLE_CSS}</style></head><body>${sheets}</body></html>`
}

export function buildSettleHtml(
  doc: InventoryDoc,
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
): string {
  const restName = tpl.restName || DEFAULT_REST_NAME
  return settleDocHtml(
    `<section class="sheet">${settleSheet(doc, tpl, lookup, opts)}</section>`,
    `${restName}-${tpl.title}-${doc.no}`,
  )
}

/** 批量：N 张进货单合成一个文档，每张一页，可一次「另存为一个 PDF」 */
export function buildSettleBatchHtml(
  list: InventoryDoc[],
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
): string {
  const restName = tpl.restName || DEFAULT_REST_NAME
  const sheets = list
    .map(
      (po, i) =>
        `<section class="sheet">${settleSheet(po, tpl, lookup, opts, {
          index: i + 1,
          total: list.length,
        })}</section>`,
    )
    .join('')
  return settleDocHtml(sheets, `${restName}-${tpl.title}-批量${list.length}张`)
}

/**
 * 通用打印：注入隐藏 iframe 并调用 print()。
 * 用 iframe 而非 window.open 是为规避弹窗拦截、且不打断当前页面状态；
 * 样式全部内联在 iframe 文档内，主页面不新增任何 @media print。
 */
export function printHtmlDoc(html: string): void {
  const old = document.getElementById('settlePrintFrame')
  if (old) old.remove()
  const frm = document.createElement('iframe')
  frm.id = 'settlePrintFrame'
  frm.setAttribute('aria-hidden', 'true')
  frm.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
  document.body.appendChild(frm)
  const doc = frm.contentWindow?.document
  if (!doc) return
  doc.open()
  doc.write(html)
  doc.close()
  setTimeout(() => {
    try {
      frm.contentWindow?.focus()
      frm.contentWindow?.print()
    } catch {
      /* 打印失败时静默：用户仍可用「导出电子版 HTML」 */
    }
  }, 260)
}
