/**
 * FP-DISH-17 下载食谱卡批量导入模板。
 *
 * 移植自旧版 downloadRecTemplate（旧 HTML:3784，由 #btnRecTpl 的 onclick 绑定，见 :3793）——
 * 表头与示例行逐字照抄旧版，保证老门店已有的食谱卡 CSV 不用改格式就能继续导入。
 *
 * 只读：只生成文件到本地下载，不发任何写请求。
 */
import { message } from 'antd'
import { download } from '../inventory/settle/download'
import { today } from '../inventory/settle/data'

/** 模板列：与 BFF 侧 IMP_REC_DEFS（lib/recipe_import.js）的同义词识别口径一致 */
export const REC_TEMPLATE_COLS = [
  '菜品名称',
  '菜品分类',
  '原料名称',
  '净料用量',
  '库存单位',
  '原料分类',
] as const

export function downloadRecipeTemplate() {
  const rows: Array<Array<string | number>> = [
    [...REC_TEMPLATE_COLS],
    ['白切文昌鸡', '爆品', '文昌鸡', 0.6, '斤', '鲜肉类'],
    ['白切文昌鸡', '爆品', '生姜', 0.02, '斤', '蔬菜类'],
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
  download('食谱卡批量导入模板_' + today() + '.csv', csv, 'text/csv')
  message.success('模板已下载：同一菜品多行即为多个原料，填写后另存为 CSV 再导入')
}
