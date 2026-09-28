import type { InventoryDoc, SettleTemplate } from '../../../api/types'
import { buildSettleData, fmt, numToCn, settleNo, today, type IngLookup } from './data'
import { downloadBlob } from './download'
import type { SettleOpts } from './html'

/**
 * 结算单 PDF 导出（**零依赖**：Canvas 光栅化 → JPEG → 极简 PDF 容器）。
 *
 * 移植自旧版 :2239-2462，常量与坐标逐一照搬，**请勿「优化」**：
 *   · PDF_SCALE=2.8 约 200dpi，改大会让体积暴涨
 *   · PDF 每页是 JPEG 位图，文字不可选中/搜索（已知限制，非 bug）
 *   · 本文件是 html.ts 版式的**镜像实现**（手工坐标），
 *     改 html.ts 的版式必须同步改 settlePageModel，否则电子版与 PDF 会漂移
 *
 * 为什么不用 jsPDF/html2canvas：PDF 标准字体不含中文，嵌入 CJK 字体又过大；
 * 光栅化能保证中文必然正确，且零依赖。
 */

const PDF_FAM = '"Microsoft YaHei","Noto Sans CJK SC","PingFang SC","微软雅黑",sans-serif'
const PDF_INK = '#111'
const PDF_LINE = '#999'
const PDF_TH = '#f2f4f7'
const PDF_GRAY = '#555'
const PDF_SUB = '#444'
const PDF_FOOT = '#666'
const PDF_W = 595.28
const PDF_H = 841.89
const PDF_MX = 34.02
const PDF_MY = 39.69
const PDF_CW = PDF_W - PDF_MX * 2
/** 渲染倍率，约 200dpi */
const PDF_SCALE = 2.8
const PDF_QUALITY = 0.9

type Align = 'left' | 'center' | 'right'

interface Cell {
  s?: string | number
  b?: boolean
  bg?: string
  align?: Align
}

type Op =
  | {
      t: 'rect'
      x: number
      y: number
      w: number
      h: number
      fill?: string
      stroke?: string
      sw?: number
    }
  | {
      t: 'line'
      x1: number
      y1: number
      x2: number
      y2: number
      color?: string
      sw?: number
      dash?: number[]
    }
  | {
      t: 'text'
      s: string
      x: number
      y: number
      font: string
      align?: Align
      color?: string
      maxW?: number
      spacing?: number
    }

export interface PdfPage {
  w: number
  h: number
  ops: Op[]
}

function pdfFont(bold: boolean, size: number): string {
  return (bold ? '700 ' : '400 ') + size + 'px ' + PDF_FAM
}

/** 画一行表格单元格；W 为列宽数组 */
function pdfCells(ops: Op[], W: number[], top: number, h: number, cells: Cell[]): void {
  let x = 0
  for (let i = 0; i < W.length; i++) {
    const c = cells[i] || {}
    const wd = W[i]
    if (c.bg) ops.push({ t: 'rect', x, y: top, w: wd, h, fill: c.bg })
    ops.push({ t: 'rect', x, y: top, w: wd, h, stroke: PDF_LINE, sw: 0.7 })
    if (c.s != null && String(c.s) !== '') {
      const al = c.align || 'left'
      ops.push({
        t: 'text',
        s: String(c.s),
        x: al === 'right' ? x + wd - 6 : al === 'center' ? x + wd / 2 : x + 6,
        y: top + h * 0.68,
        font: pdfFont(!!c.b, 9),
        align: al,
        color: PDF_INK,
        maxW: wd - 10,
      })
    }
    x += wd
  }
}

interface PageExtra {
  index?: number
  total?: number
}

/** 单张结算单 → 页面模型数组（纯计算，行数超一页时自动分页续页） */
export function settlePageModel(
  doc: InventoryDoc,
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
  extra?: PageExtra,
): PdfPage[] {
  const d = buildSettleData(doc, lookup)
  const o = opts || {}
  const ex = extra || {}
  const reportDate = o.reportDate || today()
  const purpose = o.purpose || tpl.usePurpose || '采购货款'
  const rest = tpl.restName || '熊猫五福餐厅'
  const meta = [
    tpl.addr ? '地址：' + tpl.addr : '',
    tpl.tel ? '电话：' + tpl.tel : '',
    tpl.taxNo ? '税号：' + tpl.taxNo : '',
  ]
    .filter(Boolean)
    .join('　　')

  const H = 19
  const W6 = [64, 112, 64, 112, 64, PDF_CW - 416]
  const W4 = [64, PDF_CW - 239.24, 64, 111.24]
  const WL = [31.5, PDF_CW - 271.5, 52.5, 43.5, 69, 75]
  const signList = (tpl.subjects && tpl.subjects.length ? tpl.subjects : ['经办人', '审核人', '审批人']).map(
    (x) => x + '：________________',
  )
  const batchTag = ex.total ? `\u3000·\u3000第 ${ex.index} / ${ex.total} 张` : ''
  const footR = '制单时间：' + new Date().toLocaleString('zh-CN') + batchTag

  const headRows: Cell[][] = [
    [
      { s: '单据编号', b: true, bg: PDF_TH, align: 'center' },
      { s: settleNo(doc) },
      { s: '报表日期', b: true, bg: PDF_TH, align: 'center' },
      { s: reportDate },
      { s: '付款方式', b: true, bg: PDF_TH, align: 'center' },
      { s: doc.method || '' },
    ],
    [
      { s: '进货单号', b: true, bg: PDF_TH, align: 'center' },
      { s: String(doc.no ?? '') },
      { s: '进货日期', b: true, bg: PDF_TH, align: 'center' },
      { s: String(doc.date ?? '') },
      { s: '明细项数', b: true, bg: PDF_TH, align: 'center' },
      { s: d.count + ' 项' },
    ],
    [
      { s: '收款单位', b: true, bg: PDF_TH, align: 'center' },
      { s: String(doc.supplier ?? '') },
      { s: '支出用途', b: true, bg: PDF_TH, align: 'center' },
      { s: purpose },
    ],
  ]
  const widths = [W6, W6, W4]
  if (tpl.payeeName || tpl.payeeBank || tpl.payeeAccount) {
    headRows.push([
      { s: '开户行', b: true, bg: PDF_TH, align: 'center' },
      { s: tpl.payeeBank || '' },
      { s: '银行账号', b: true, bg: PDF_TH, align: 'center' },
      { s: tpl.payeeAccount || '' },
    ])
    widths.push(W4)
  }

  const topH = 40 + (meta ? 16 : 8) + 7 + headRows.length * H + 7 + H
  const contH = 22 + H
  /** 合计框 + 签字栏 + 页脚 */
  const TAIL = 6 + 60 + 18 + 30 + 14 + 20

  const cap1 = Math.max(1, Math.floor((PDF_H - PDF_MY * 2 - topH) / H))
  const capN = Math.max(1, Math.floor((PDF_H - PDF_MY * 2 - contH) / H))
  const pages: Array<{ first: boolean; rows: typeof d.lines }> = []
  let idx = 0
  while (idx < d.lines.length) {
    const cap = pages.length === 0 ? cap1 : capN
    pages.push({ first: pages.length === 0, rows: d.lines.slice(idx, idx + cap) })
    idx += cap
  }
  if (!pages.length) pages.push({ first: true, rows: [] })

  const CH = PDF_H - PDF_MY * 2
  for (let g = 0; g < 200; g++) {
    const last = pages[pages.length - 1]
    const used = (last.first ? topH : contH) + last.rows.length * H
    if (CH - used >= TAIL) break
    const move = Math.min(last.rows.length, Math.max(1, Math.ceil((TAIL - (CH - used)) / H)))
    if (!move) break
    pages.push({ first: false, rows: last.rows.splice(last.rows.length - move, move) })
  }

  return pages.map((pg, pi) => {
    const ops: Op[] = []
    let y = 0
    if (pg.first) {
      ops.push({ t: 'text', s: rest, x: PDF_CW / 2, y: 13.5, font: pdfFont(true, 13), align: 'center', spacing: 1.5 })
      ops.push({ t: 'text', s: tpl.title, x: PDF_CW / 2, y: 30, font: pdfFont(true, 11.5), align: 'center', spacing: 4.5 })
      y = 40
      if (meta) {
        ops.push({ t: 'text', s: meta, x: PDF_CW / 2, y: y + 11, font: pdfFont(false, 8.5), align: 'center', color: PDF_GRAY })
        y += 16
      }
      y += 7
      headRows.forEach((cells, i) => pdfCells(ops, widths[i], y + i * H, H, cells))
      y += headRows.length * H + 7
    } else {
      ops.push({
        t: 'text',
        s: rest + ' · ' + tpl.title + ' · ' + settleNo(doc) + '（续）',
        x: PDF_CW / 2,
        y: 13,
        font: pdfFont(true, 9.5),
        align: 'center',
      })
      y = contH - H
    }
    pdfCells(ops, WL, y, H, [
      { s: '序号', b: true, bg: PDF_TH, align: 'center' },
      { s: '品名', b: true, bg: PDF_TH },
      { s: '数量', b: true, bg: PDF_TH, align: 'center' },
      { s: '单位', b: true, bg: PDF_TH, align: 'center' },
      { s: '单价(元)', b: true, bg: PDF_TH, align: 'right' },
      { s: '金额(元)', b: true, bg: PDF_TH, align: 'right' },
    ])
    y += H
    pg.rows.forEach((l) => {
      pdfCells(ops, WL, y, H, [
        { s: l.no, align: 'center' },
        { s: l.name },
        { s: l.qty, align: 'center' },
        { s: l.buyUnit, align: 'center' },
        { s: fmt(l.price), align: 'right' },
        { s: fmt(l.amount), align: 'right' },
      ])
      y += H
    })
    if (pi === pages.length - 1) {
      y += 6
      ops.push({ t: 'rect', x: 0, y, w: PDF_CW, h: 60, stroke: PDF_LINE, sw: 0.7 })
      let sy = y + 17
      ops.push({ t: 'text', s: '小写合计：', x: 8, y: sy, font: pdfFont(true, 9.5) })
      ops.push({ t: 'text', s: '¥' + fmt(d.payable), x: 66, y: sy, font: pdfFont(true, 11) })
      sy += 14
      ops.push({
        t: 'text',
        s: '人民币大写：' + numToCn(d.payable),
        x: 8,
        y: sy,
        font: pdfFont(true, 10),
        maxW: PDF_CW - 16,
      })
      sy += 13
      ops.push({
        t: 'text',
        s:
          `明细 ${d.count} 项 · 合计数量 ${fmt(d.totalQty, 3)}\u3000|\u3000应付全额 ¥${fmt(d.payable)}\u3000已付 ¥${fmt(
            d.paid,
          )}\u3000欠款 ¥${fmt(d.debt)}`,
        x: 8,
        y: sy,
        font: pdfFont(false, 8.5),
        color: PDF_SUB,
        maxW: PDF_CW - 16,
      })
      y += 60 + 18
      const slot = PDF_CW / Math.max(1, signList.length)
      signList.forEach((s, i) => ops.push({ t: 'text', s, x: i * slot, y: y + 12, font: pdfFont(false, 9.5) }))
      y += 30 + 14
      ops.push({ t: 'line', x1: 0, y1: y, x2: PDF_CW, y2: y, color: '#bbb', sw: 0.7, dash: [3, 2.5] })
      ops.push({ t: 'text', s: tpl.footer || '', x: 0, y: y + 12, font: pdfFont(false, 8), color: PDF_FOOT, maxW: PDF_CW - 170 })
      ops.push({ t: 'text', s: footR, x: PDF_CW, y: y + 12, font: pdfFont(false, 8), color: PDF_FOOT, align: 'right' })
    }
    return { w: PDF_W, h: PDF_H, ops }
  })
}

/** 按宽度裁剪文字并加省略号（表格单元格内不换行） */
function pdfClip(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (!maxW || ctx.measureText(s).width <= maxW) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}

/** 把页面模型画到 canvas（白底 A4，含 12mm/14mm 页边距） */
export function pdfPaint(cv: HTMLCanvasElement, model: PdfPage): void {
  const S = PDF_SCALE
  cv.width = Math.round(model.w * S)
  cv.height = Math.round(model.h * S)
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('无法获取 canvas 2d 上下文')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, cv.width, cv.height)
  ctx.scale(S, S)
  ctx.translate(PDF_MX, PDF_MY)
  ctx.textBaseline = 'alphabetic'
  model.ops.forEach((o) => {
    if (o.t === 'rect') {
      if (o.fill) {
        ctx.fillStyle = o.fill
        ctx.fillRect(o.x, o.y, o.w, o.h)
      }
      if (o.stroke) {
        ctx.strokeStyle = o.stroke
        ctx.lineWidth = o.sw || 0.7
        ctx.strokeRect(o.x, o.y, o.w, o.h)
      }
      return
    }
    if (o.t === 'line') {
      ctx.save()
      ctx.strokeStyle = o.color || PDF_LINE
      ctx.lineWidth = o.sw || 0.7
      if (o.dash) ctx.setLineDash(o.dash)
      ctx.beginPath()
      ctx.moveTo(o.x1, o.y1)
      ctx.lineTo(o.x2, o.y2)
      ctx.stroke()
      ctx.restore()
      return
    }
    ctx.save()
    ctx.font = o.font
    ctx.fillStyle = o.color || PDF_INK
    ctx.textAlign = o.align === 'center' || o.align === 'right' ? o.align : 'left'
    let s = String(o.s)
    if (o.maxW) s = pdfClip(ctx, s, o.maxW)
    if (o.spacing) {
      const sp = o.spacing
      const cs = Array.from(s)
      const wds = cs.map((c) => ctx.measureText(c).width)
      const tw = wds.reduce((a, b) => a + b, 0) + sp * (cs.length - 1)
      let x = o.x - (ctx.textAlign === 'center' ? tw / 2 : ctx.textAlign === 'right' ? tw : 0)
      cs.forEach((c, i) => {
        ctx.fillText(c, x, o.y)
        x += wds[i] + sp
      })
    } else {
      ctx.fillText(s, o.x, o.y)
    }
    ctx.restore()
  })
}

function pdfCanvasJpeg(cv: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((res, rej) => {
    if (typeof cv.toBlob === 'function') {
      cv.toBlob((b) => {
        if (!b) return rej(new Error('画布导出失败'))
        b.arrayBuffer().then((ab) => res(new Uint8Array(ab))).catch(rej)
      }, 'image/jpeg', PDF_QUALITY)
    } else {
      try {
        const d = cv.toDataURL('image/jpeg', PDF_QUALITY).split(',')[1]
        const bin = atob(d)
        const u8 = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
        res(u8)
      } catch (e) {
        rej(e)
      }
    }
  })
}

interface JpegPage {
  jpeg: Uint8Array
  pxW: number
  pxH: number
}

/**
 * 极简 PDF 容器：把每页 JPEG 作为 DCTDecode 图像 XObject 写入（纯字节拼装，无依赖）。
 * 对象编号：1=Catalog 2=Pages 之后每页 3 个（页 / 内容流 / 图像）。
 */
export function buildPdfBytes(pages: JpegPage[], wPt: number, hPt: number): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  let len = 0
  const objOff: number[] = []
  const wS = (s: string) => {
    const b = enc.encode(s)
    parts.push(b)
    len += b.length
  }
  const wB = (b: Uint8Array) => {
    parts.push(b)
    len += b.length
  }
  const N = pages.length
  const pageObj = (i: number) => 3 + 3 * i
  const contObj = (i: number) => 4 + 3 * i
  const imgObj = (i: number) => 5 + 3 * i
  wS('%PDF-1.4\n')
  /* 二进制标记行，便于阅读器识别为二进制 PDF */
  wB(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))
  objOff[1] = len
  wS('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  objOff[2] = len
  wS(
    '2 0 obj\n<< /Type /Pages /Count ' +
      N +
      ' /Kids [' +
      pages.map((_, i) => pageObj(i) + ' 0 R').join(' ') +
      '] >>\nendobj\n',
  )
  for (let i = 0; i < N; i++) {
    const pg = pages[i]
    const W = wPt.toFixed(2)
    const Hh = hPt.toFixed(2)
    objOff[pageObj(i)] = len
    wS(
      pageObj(i) +
        ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' +
        W +
        ' ' +
        Hh +
        '] /Resources << /XObject << /Im0 ' +
        imgObj(i) +
        ' 0 R >> >> /Contents ' +
        contObj(i) +
        ' 0 R >>\nendobj\n',
    )
    const cs = 'q\n' + W + ' 0 0 ' + Hh + ' 0 0 cm\n/Im0 Do\nQ\n'
    objOff[contObj(i)] = len
    wS(contObj(i) + ' 0 obj\n<< /Length ' + cs.length + ' >>\nstream\n' + cs + 'endstream\nendobj\n')
    objOff[imgObj(i)] = len
    wS(
      imgObj(i) +
        ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' +
        pg.pxW +
        ' /Height ' +
        pg.pxH +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
        pg.jpeg.length +
        ' >>\nstream\n',
    )
    wB(pg.jpeg)
    wS('\nendstream\nendobj\n')
  }
  /** 对象 1..(2+3N)，xref 条目 = 对象数 + free 项 */
  const total = 3 + 3 * N
  const xref = len
  let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n'
  for (let i = 1; i < total; i++) x += String(objOff[i]).padStart(10, '0') + ' 00000 n \n'
  x += 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n'
  wS(x)
  const out = new Uint8Array(len)
  let off = 0
  parts.forEach((b) => {
    out.set(b, off)
    off += b.length
  })
  return out
}

/** 结算单 → PDF Blob（单张或批量；批量 = 每张结算单连续多页） */
export async function settlePdfBlob(
  list: InventoryDoc[],
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
  single?: boolean,
): Promise<Blob> {
  const models: PdfPage[] = []
  list.forEach((po, i) => {
    settlePageModel(po, tpl, lookup, opts, single ? undefined : { index: i + 1, total: list.length }).forEach(
      (m) => models.push(m),
    )
  })
  const cv = document.createElement('canvas')
  const pages: JpegPage[] = []
  for (let i = 0; i < models.length; i++) {
    pdfPaint(cv, models[i])
    pages.push({ jpeg: await pdfCanvasJpeg(cv), pxW: cv.width, pxH: cv.height })
  }
  return new Blob([buildPdfBytes(pages, PDF_W, PDF_H)], { type: 'application/pdf' })
}

/** 生成并下载 PDF，返回文件名 */
export async function exportSettlePdf(
  list: InventoryDoc[],
  tpl: SettleTemplate,
  lookup: IngLookup,
  opts?: SettleOpts,
  single?: boolean,
): Promise<string> {
  if (!list.length) throw new Error('请先选择进货单')
  const blob = await settlePdfBlob(list, tpl, lookup, opts, single)
  const rd = opts?.reportDate || today()
  const name = single
    ? `结算单_${settleNo(list[0])}_${rd}.pdf`
    : `结算单_批量_${rd}_${list.length}张.pdf`
  downloadBlob(name, blob)
  return name
}
