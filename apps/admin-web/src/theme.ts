/*
 * 主题 token：对齐《熊猫五福App原型》视觉。
 * 主色 #1A1A1A；AI 强调渐变 #F48FB1→#9B6BBF；
 * 五福色：红 #E8584A / 黑 #3A3A3A / 黄 #F2B233 / 绿 #5BA85B / 紫 #9B6BBF。
 */
import type { ThemeConfig } from 'antd'

export const COLORS = {
  primary: '#1A1A1A',
  aiGradient: 'linear-gradient(135deg, #F48FB1 0%, #9B6BBF 100%)',
  red: '#E8584A',
  black: '#3A3A3A',
  yellow: '#F2B233',
  green: '#5BA85B',
  purple: '#9B6BBF',
} as const

export const themeConfig: ThemeConfig = {
  token: {
    colorPrimary: COLORS.primary,
    colorInfo: COLORS.primary,
    colorSuccess: COLORS.green,
    colorWarning: COLORS.yellow,
    colorError: COLORS.red,
    colorLink: COLORS.purple,
    borderRadius: 8,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif',
  },
  components: {
    Layout: {
      siderBg: COLORS.primary,
      headerBg: '#ffffff',
      headerHeight: 56,
    },
    Menu: {
      darkItemBg: COLORS.primary,
      darkSubMenuItemBg: '#111111',
      darkItemSelectedBg: COLORS.purple,
    },
  },
}
