import { useEffect, useMemo, useState } from 'react'
import {
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router-dom'
import {
  Breadcrumb,
  Button,
  Drawer,
  Input,
  Layout,
  Menu,
  Result,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  LogoutOutlined,
  MenuOutlined,
  MobileOutlined,
  SearchOutlined,
  ShopOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../store/auth'
import EnvBanner from '../components/EnvBanner'
import { canAccess, firstAccessiblePath } from '../rbac/roles'
import { MENU, findLeaf } from '../config/menu'
import { fetchHealth, fetchOrg } from '../api'
import type { Health, OrgStore } from '../api/types'
import { COLORS } from '../theme'
import { useIsMobile } from '../hooks/useIsMobile'

const { Sider, Header, Content } = Layout

const ROLE_TAG_COLOR: Record<string, string> = {
  老板: COLORS.red,
  店长: COLORS.purple,
  财务: COLORS.yellow,
  厨房: COLORS.green,
  收银: '#F48FB1',
  只读: COLORS.black,
}

export default function MainLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { role, account, logout, storeId, storeName, setStore, canWrite } = useAuthStore()
  const [health, setHealth] = useState<Health | null>(null)
  const [stores, setStores] = useState<OrgStore[]>([])
  /* 手机端：侧边栏改为抽屉，顶栏只留汉堡 + 当前页 + 退出（E1 手机壳） */
  const isMobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)

  /* 换页自动收起抽屉，避免挡住内容 */
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

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

  useEffect(() => {
    fetchOrg()
      .then((o) => {
        setStores(o.stores || [])
        if (!storeId && o.stores?.[0]) {
          setStore({ storeId: o.stores[0].id, storeName: o.stores[0].name })
        }
      })
      .catch(() => setStores([]))
  }, [storeId, setStore])

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
        children: children.map((leaf) => ({
          key: leaf.path,
          label: leaf.reserved
            ? <span>{leaf.title}<Tag color="orange" style={{ marginInlineStart: 4 }}>接口预留</Tag></span>
            : leaf.title,
        })),
      }
    }).filter(Boolean) as MenuProps['items']
  }, [role])

  const allowed = canAccess(role, location.pathname)
  const matched = findLeaf(location.pathname)
  const openKey = matched?.group.key

  /* 深链/直接访问时自动展开所属菜单分组 */
  const [openKeys, setOpenKeys] = useState<string[]>(openKey ? [openKey] : [])
  useEffect(() => {
    if (openKey) {
      setOpenKeys((ks) => (ks.includes(openKey) ? ks : [...ks, openKey]))
    }
  }, [openKey])

  const onLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const onStoreChange = (id: string) => {
    const s = stores.find((x) => x.id === id)
    if (!s) return
    setStore({ storeId: s.id, storeName: s.name })
    message.success(`已切换门店：${s.name}`)
  }

  /* 侧边栏内容两端共用：桌面直出、手机装进抽屉 */
  const brandNode = (
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
      熊猫五福 · SaaS
    </div>
  )
  const navMenu = (
    <Menu
      theme="dark"
      mode="inline"
      items={menuItems}
      selectedKeys={[location.pathname]}
      openKeys={openKeys}
      onOpenChange={(keys) => setOpenKeys(keys as string[])}
      onClick={({ key }) => {
        navigate(key)
        setNavOpen(false)
      }}
    />
  )

  return (
    <>
      {/* 演练环境横幅：仅当 BFF /api/health 返回 env=sandbox 时展示 */}
      <EnvBanner env={health?.env} />
      <Layout style={{ minHeight: '100vh' }}>
      {/* 手机端不占屏：侧边栏收进抽屉，内容区拿回 220px */}
      {isMobile ? (
        <Drawer
          placement="left"
          open={navOpen}
          onClose={() => setNavOpen(false)}
          width={248}
          closable={false}
          styles={{ body: { padding: 0, background: '#001529' } }}
        >
          {brandNode}
          {navMenu}
        </Drawer>
      ) : (
        <Sider width={220} theme="dark">
          {brandNode}
          {navMenu}
        </Sider>
      )}
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: isMobile ? '0 8px' : '0 20px',
            borderBottom: '1px solid #f0f0f0',
            background: isMobile ? '#fff' : undefined,
            position: isMobile ? 'sticky' : undefined,
            top: isMobile ? 0 : undefined,
            zIndex: isMobile ? 20 : undefined,
          }}
        >
          {/* 手机端：汉堡开抽屉 + 只显示当前页名，其余头部信息收起，避免挤成竖排 */}
          {isMobile && (
            <Button
              type="text"
              icon={<MenuOutlined />}
              onClick={() => setNavOpen(true)}
              aria-label="打开菜单"
            />
          )}
          {isMobile ? (
            <Typography.Text
              strong
              style={{
                fontSize: 15,
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {matched ? matched.leaf.title : '熊猫五福'}
            </Typography.Text>
          ) : (
          <Breadcrumb
            items={[
              { title: '熊猫五福' },
              ...(matched
                ? [{ title: matched.group.label }, { title: matched.leaf.title }]
                : []),
            ]}
          />
          )}
          {isMobile ? (
            <Space size={4} style={{ flexShrink: 0 }}>
              <Tag color={ROLE_TAG_COLOR[role ?? ''] ?? 'default'} style={{ marginInlineEnd: 0 }}>
                {role ?? '-'}
              </Tag>
              <Button type="text" icon={<LogoutOutlined />} onClick={onLogout} aria-label="退出" />
            </Space>
          ) : (
          <Space size="middle" wrap>
            <Input.Search
              allowClear
              size="small"
              prefix={<SearchOutlined style={{ color: '#bbb' }} />}
              placeholder="全局搜索"
              style={{ width: 200 }}
              onSearch={(v) => {
                const val = v.trim()
                if (val) navigate(`/search?q=${encodeURIComponent(val)}`)
              }}
            />
            <Select
              size="small"
              style={{ minWidth: 200 }}
              placeholder="选择门店"
              value={storeId ?? undefined}
              onChange={onStoreChange}
              suffixIcon={<ShopOutlined />}
              options={(stores.length
                ? stores
                : storeId
                  ? [{ id: storeId, name: storeName || storeId }]
                  : []
              ).map((s) => ({ value: s.id, label: s.name }))}
            />
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
            <Tag color={canWrite ? 'blue' : 'default'}>{canWrite ? '可写' : '只读'}</Tag>
            <Typography.Text type="secondary">{account}</Typography.Text>
            {/* E 移动端适配完成前，手机入口直接落到手机可用的业务页（入库单），
                不再指向 /m 预览壳（只有文案、无真数据）。适配到位后可改回 /m。 */}
            <Button
              type="primary"
              ghost
              size="small"
              icon={<MobileOutlined />}
              onClick={() => navigate('/inventory/inbound')}
            >
              手机版
            </Button>
            <Button type="text" icon={<LogoutOutlined />} onClick={onLogout}>
              退出
            </Button>
          </Space>
          )}
        </Header>
        <Content style={{ padding: isMobile ? 12 : 20, background: '#f5f5f5' }}>
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
    </>
  )
}
