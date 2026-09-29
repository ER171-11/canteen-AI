/**
 * FP-RECV-03 下载进货单批量导入模板。
 *
 * 移植自旧版 downloadPoTemplate（旧 HTML:3778，由 #btnRecvTpl 的 onclick 绑定，见 :3791）——
 * 「进货入库」页的模板按钮在旧版实际调用的正是这一份模板。
 *
 * 只读：只生成文件到本地下载，不发任何写请求（与结算单导出同层处理）。
 */
import { message } from 'antd'
import { download } from './settle/download'
import { today } from './settle/data'

/** 模板列：与 BFF 侧 IMP_PO_DEFS（lib/recv_import.js）的同义词识别口径一致 */
export const TEMPLATE_COLS = ['供应商', '日期', '原料名称', '数量', '单价', '备注'] as const

export function downloadRecvTemplate() {
  const rows: Array<Array<string | number>> = [
    [...TEMPLATE_COLS],
    ['海南菜篮子实业有限公司', today(), '东古一品鲜500ml', 5, 8.1, '示例行，导入前请删除'],
  ]
  const csv =
    '\ufeff' +
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = String(v ?? '')
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
          })
          .join(','),
      )
      .join('\r\n')
  download('进货单批量导入模板_' + today() + '.csv', csv, 'text/csv')
  message.success('模板已下载：用 Excel 按列填写后另存为 CSV 再导入')
}
