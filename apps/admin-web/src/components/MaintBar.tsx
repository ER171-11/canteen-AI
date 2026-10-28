import { Button, Space, Tag, Typography } from 'antd'
import { exitMaint, maintEnabled } from '../utils/maint'

/*
 * 清理模式悬浮指示条（测试期隐藏工具）
 * 默认（未激活）渲染 null——正式版界面上完全不存在；
 * 仅当 localStorage 清理标志开启时，左下角显示一个小指示条 + 退出按钮。
 */
export default function MaintBar() {
  if (!maintEnabled()) return null
  return (
    <div style={{ position: 'fixed', left: 24, bottom: 24, zIndex: 1200 }}>
      <Space size={8} style={{ background: '#fff', padding: '4px 10px', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
        <Tag color="purple" style={{ margin: 0 }}>
          清理模式 · 测试期
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          行内「删」按钮可用，删除走审批中心留痕
        </Typography.Text>
        <Button size="small" onClick={exitMaint}>
          退出
        </Button>
      </Space>
    </div>
  )
}
