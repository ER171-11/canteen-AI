import { useEffect, useSyncExternalStore } from 'react'
import { useLocation } from 'react-router-dom'
import { Badge, Button, Divider, Popover, Space, Switch, Tag, Typography, message } from 'antd'
import { ExperimentOutlined, ReloadOutlined } from '@ant-design/icons'
import { useAuthStore } from '../store/auth'
import { useDemo } from '../store/demo'
import { mockHits, resetMockHits, subscribeMockHits } from '../utils/demoGate'

/*
 * 全局「演示数据开关」悬浮组件（过渡期临时工具 A）
 *
 * 目的：演示/验收时一键关闭内置演示数据，让界面回落为真实空态。
 * 行为：只切换开关并刷新页面，不触碰任何业务逻辑；关闭后所有 mock 回退点返回空态。
 * 淘汰完成后本组件应随 store/demo 与 utils/demoGate 一并移除。
 */
export default function DemoSwitch() {
  const token = useAuthStore((s) => s.token)
  const { enabled, setDemo, urlLocked } = useDemo()
  const hits = useSyncExternalStore(subscribeMockHits, mockHits, mockHits)
  const location = useLocation()

  /* 路由切换时重置「本页回退次数」 */
  useEffect(() => {
    resetMockHits()
  }, [location.pathname])

  /* 登录页不展示 */
  if (!token) return null

  const onToggle = (next: boolean) => {
    if (urlLocked) {
      message.warning('演示开关由 URL 参数 ?demo 锁定，请修改地址栏参数后刷新')
      return
    }
    setDemo(next)
    message.info(`演示数据已${next ? '开启' : '关闭'}，正在刷新…`)
    window.setTimeout(() => window.location.reload(), 300)
  }

  const panel = (
    <Space direction="vertical" size={8} style={{ width: 280 }}>
      <Space size={8} wrap>
        <Typography.Text strong>演示数据</Typography.Text>
        <Tag color={enabled ? 'warning' : 'success'}>{enabled ? '开启中' : '已关闭'}</Tag>
        {urlLocked ? <Tag color="blue">URL 锁定</Tag> : null}
      </Space>
      <Space size={8}>
        <Switch checked={enabled} disabled={urlLocked} onChange={onToggle} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          关闭后所有模拟数据回退为空态
        </Typography.Text>
      </Space>
      <Divider style={{ margin: '4px 0' }} />
      <Space size={8}>
        <Typography.Text style={{ fontSize: 12 }}>本页演示数据回退次数：</Typography.Text>
        <Badge count={hits} showZero color={hits ? '#E8584A' : '#5BA85B'} />
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        {hits > 0
          ? '该页面仍有回退到内置演示数据的逻辑（数据已被空态替代）'
          : '当前页面未触发演示数据回退'}
      </Typography.Text>
      <Divider style={{ margin: '4px 0' }} />
      <Space size={8}>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>
          刷新
        </Button>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          过渡期临时工具，淘汰完成后移除
        </Typography.Text>
      </Space>
    </Space>
  )

  return (
    <div style={{ position: 'fixed', right: 24, bottom: 24, zIndex: 1200 }}>
      <Popover content={panel} title="运行时演示开关" trigger="click" placement="topRight">
        <Button
          type={enabled ? 'primary' : 'default'}
          danger={enabled}
          icon={<ExperimentOutlined />}
          shape="round"
          style={{ boxShadow: '0 4px 12px rgba(0,0,0,0.18)' }}
        >
          演示数据 · {enabled ? '开' : '关'}
          {hits > 0 ? ` (${hits})` : ''}
        </Button>
      </Popover>
    </div>
  )
}
