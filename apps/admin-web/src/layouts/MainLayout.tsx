import { useEffect, useMemo, useState } from 'react'
import {
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import {
  Breadcrumb,
  Button,
  Layout,
  Menu,
  Result,
  Space,
  Tag,
  Typography,
} from 'antd'
import type { MenuProps } from 'antd'
import { LogoutOutlined, SyncOutlined } from '@ant-design/icons'
import { useAuthStore } from '../store/auth'
import { canAccess, firstAccessiblePath } from '../rbac/roles'
import { MENU, findLeaf } from '../config/menu'
import { fetchHealth } from '../api'
import type { Health } from '../api/types'
import { COLORS } from '../theme'

const { Sider, Header, Content } = Layout

const ROLE_TAG_COLOR: Record<string, string> = {
  老板: COLORS.red,
  店长: COLORS.purple,
  财务: COLORS.yellow,
  厨房: COLORS.green,
  只读: COLORS.black,
}

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { role, account, logout } = useAuthStore()
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    let alive = true
    const pull = () =>
      fetchHealth()
        .then((h) => alive && setHealth(h))
        .catch(() => alive && setHealth(null))
    pull()
    const timer = setInterval(pull, 30000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  /* 菜单按角色过滤 */
  const menuItems: MenuProps['items'] = useMemo(() => {
    if (!role) return []
    return MENU.map((group) => {
      const children = group.children.filter((leaf) => canAccess(role, leaf.path))
      if (children.length === 0) return null
      return {
        key: group.key,
        icon: group.icon,
        label: group.label,
        children: children.map((leaf) => ({ key: leaf.path, label: leaf.title })),
      }
    }).filter(Boolean) as MenuProps['items']
  }, [role])

  const allowed = canAccess(role, location.pathname)
  const matched = findLeaf(location.pathname)
  const openKey = matched?.group.key

  const onLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={220} theme="dark">
        <div
          className="ai-gradient-text"
          style={{
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 17,
            fontWeight: 700,
            background: '#111',
          }}
        >
          熊猫五福 · 管理后台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          items={menuItems}
          selectedKeys={[location.pathname]}
          defaultOpenKeys={openKey ? [openKey] : []}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 20px',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <Breadcrumb
            items={[
              { title: '熊猫五福' },
              ...(matched
                ? [{ title: matched.group.label }, { title: matched.leaf.title }]
                : []),
            ]}
          />
          <Space size="middle">
            {health ? (
              <Tag icon={<SyncOutlined spin={false} />} color="success">
                快照 rev {health.rev ?? '-'} ·{' '}
                {health.updated_at
                  ? new Date(health.updated_at).toLocaleString('zh-CN')
                  : health.time
                    ? new Date(health.time).toLocaleString('zh-CN')
                    : '-'}
              </Tag>
            ) : (
              <Tag color="default">BFF 离线</Tag>
            )}
            <Tag color={ROLE_TAG_COLOR[role ?? ''] ?? 'default'}>
              {role ?? '未知角色'}
            </Tag>
            <Typography.Text type="secondary">{account}</Typography.Text>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              onClick={onLogout}
            >
              退出
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 20, background: '#f5f5f5' }}>
          {allowed ? (
            <Outlet />
          ) : (
            <Result
              status="403"
              title="无访问权限"
              subTitle={`当前角色「${role ?? '-'}」无权访问该模块`}
              extra={
                <Button
                  type="primary"
                  onClick={() => navigate(firstAccessiblePath(role))}
                >
                  返回我的首页
                </Button>
              }
            />
          )}
        </Content>
      </Layout>
    </Layout>
  )
}
