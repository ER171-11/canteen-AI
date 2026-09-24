import { COLORS } from '../../theme'

export interface ColorMeta {
  hex: string
  label: string
  /** 色源（色源锁定原料） */
  source: string
}

/*
 * 五色元数据：色源锁定规则与原型一致（红=火龙果汁 / 黄=南瓜泥 / 绿=菠菜汁 /
 * 紫=紫薯粉 / 黑=墨鱼汁）。key 同时兼容英文与中文下发值。
 */
const META: Record<string, ColorMeta> = {
  red: { hex: COLORS.red, label: '红', source: '火龙果汁' },
  红: { hex: COLORS.red, label: '红', source: '火龙果汁' },
  black: { hex: COLORS.black, label: '黑', source: '墨鱼汁' },
  黑: { hex: COLORS.black, label: '黑', source: '墨鱼汁' },
  yellow: { hex: COLORS.yellow, label: '黄', source: '南瓜泥' },
  黄: { hex: COLORS.yellow, label: '黄', source: '南瓜泥' },
  green: { hex: COLORS.green, label: '绿', source: '菠菜汁' },
  绿: { hex: COLORS.green, label: '绿', source: '菠菜汁' },
  purple: { hex: COLORS.purple, label: '紫', source: '紫薯粉' },
  紫: { hex: COLORS.purple, label: '紫', source: '紫薯粉' },
  white: { hex: '#d9d9d9', label: '白', source: '原味面皮' },
  白: { hex: '#d9d9d9', label: '白', source: '原味面皮' },
}

export function colorMeta(color: string | undefined): ColorMeta {
  if (color && META[color]) return META[color]
  return { hex: '#999999', label: color || '?', source: '未知' }
}

/** 五色展示顺序 */
export const FIVE_COLOR_ORDER = ['red', 'yellow', 'green', 'purple', 'black']

/** 归一化到英文 key 用于排序（中文值映射回英文） */
export function colorOrderKey(color: string): string {
  const zh2en: Record<string, string> = {
    红: 'red',
    黄: 'yellow',
    绿: 'green',
    紫: 'purple',
    黑: 'black',
    白: 'white',
  }
  return zh2en[color] ?? color
}

/** SOP 阶段展示顺序 */
export const STAGE_ORDER = [
  '和面',
  '醒发',
  '备馅',
  '拌馅',
  '剂子',
  '包制',
  '煮制',
  '装盘',
]
