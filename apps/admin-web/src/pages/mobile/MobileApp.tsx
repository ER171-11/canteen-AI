import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button,
  Dropdown,
  Empty,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import type { MenuProps } from 'antd'
import {
  AlertOutlined,
  CheckCircleOutlined,
  DesktopOutlined,
  DownOutlined,
  FireOutlined,
  FundOutlined,
  HomeOutlined,
  LeftOutlined,
  LogoutOutlined,
  RightOutlined,
  RobotOutlined,
  ShopOutlined,
  UserOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '../../store/auth'
import { fetchHealth, fetchOrg, fetchReportDaily } from '../../api'
import type { Health, OrgStore, ReportDaily } from '../../api/types'
import { COLORS } from '../../theme'
import InspectionFlow from './InspectionFlow'
import {
  FRONT_MODULE_KEYS,
  FRONT_PIPE,
  GROUP_HINT,
  GROUP_ORDER,
  KITCHEN_MODULE_KEYS,
  KITCHEN_PIPE,
  SI_PROMPTS,
  TAB_ORDER,
  TAB_SUB,
  moduleByKey,
  modulesIn,
  type MobileModule,
  type TabKey,
} from './data'

const { Text, Title } = Typography

/* 金额格式化（整数元） */
const fmt = (n?: number | null) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '-'
    : `¥${Math.round(n).toLocaleString('zh-CN')}`

const greeting = () => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/* ------------------------------------------------------------------ */
/* 通用小组件                                                          */
/* ------------------------------------------------------------------ */

function SectionTitle({ icon, title, extra }: { icon?: React.ReactNode; title: string; extra?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '18px 2px 10px' }}>
      <Text strong style={{ fontSize: 15 }}>
        {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
        {title}
      </Text>
      {extra}
    </div>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: '#fff',
        borderRadius: 14,
        padding: 14,
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** 宫格单格（模块入口） */
function ModuleTile({ m, onOpen }: { m: MobileModule; onOpen: (m: MobileModule) => void }) {
  return (
    <div
      onClick={() => onOpen(m)}
      style={{
        background: '#fff',
        borderRadius: 14,
        padding: '12px 10px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        cursor: 'pointer',
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)',
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 12,
          background: m.iconBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 18,
          fontWeight: 700,
          color: '#3A3A3A',
        }}
      >
        {m.label.slice(0, 1)}
      </div>
      <Text strong style={{ fontSize: 13 }}>{m.label}</Text>
      <Text type="secondary" style={{ fontSize: 10, lineHeight: 1.2, textAlign: 'center' }}>
        {m.gridSub}
      </Text>
    </div>
  )
}

function ModuleGrid({ keys, onOpen }: { keys: string[]; onOpen: (m: MobileModule) => void }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
      {keys.map((k) => {
        const m = moduleByKey(k)
        return m ? <ModuleTile key={k} m={m} onOpen={onOpen} /> : null
      })}
    </div>
  )
}

/** 管道（前厅/后厨流程） */
function PipeView({ pipe }: { pipe: Array<{ title: string; items: string[] }> }) {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {pipe.map((step, i) => (
          <div key={step.title} style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  background: COLORS.aiGradient,
                  color: '#fff',
                  fontSize: 12,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {i + 1}
              </div>
              {i < pipe.length - 1 && <div style={{ flex: 1, width: 2, background: '#eee' }} />}
            </div>
            <div style={{ flex: 1, paddingBottom: i < pipe.length - 1 ? 10 : 0 }}>
              <Text strong style={{ fontSize: 13 }}>{step.title}</Text>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {step.items.map((it) => (
                  <Tag key={it} style={{ marginInlineEnd: 0, fontSize: 11 }}>{it}</Tag>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

/** 模块详情（手机端点进去看什么） */
function ModuleDetail({ m, onBack, onOpenDesktop }: { m: MobileModule; onBack: () => void; onOpenDesktop: (p?: string) => void }) {
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button type="text" size="small" icon={<LeftOutlined />} onClick={onBack} />
        <Text strong style={{ fontSize: 16 }}>{m.label}</Text>
        {m.reserved && <Tag color="orange" style={{ fontSize: 11 }}>接口预留</Tag>}
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              background: m.iconBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              fontWeight: 700,
              color: '#3A3A3A',
              flexShrink: 0,
            }}
          >
            {m.label.slice(0, 1)}
          </div>
          <Text type="secondary" style={{ fontSize: 13 }}>{m.oneLiner}</Text>
        </div>
      </Card>

      <div>
        <SectionTitle title="页内分组" />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {m.pills.map((p) => (
            <Tag key={p} color="purple" style={{ fontSize: 12 }}>{p}</Tag>
          ))}
        </div>
      </div>

      <div>
        <SectionTitle title="手机端会看到 / 能做什么" />
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {m.leaves.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ color: COLORS.green, lineHeight: 1.5 }}>·</span>
                <Text style={{ fontSize: 13, lineHeight: 1.5, flex: 1 }}>{l}</Text>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {m.desktopPath && (
        <Button block type="primary" icon={<DesktopOutlined />} onClick={() => onOpenDesktop(m.desktopPath)}>
          打开桌面版完整页（有真数据）
        </Button>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 各 Tab                                                              */
/* ------------------------------------------------------------------ */

function TodayTab({
  report,
  loading,
  onOpenModule,
}: {
  report: ReportDaily | null
  loading: boolean
  onOpenModule: (m: MobileModule) => void
}) {
  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />
  if (!report) return <Empty style={{ marginTop: 48 }} description="今日看板暂无数据" />

  const kpis: Array<{ label: string; value: string | number; delta?: string | null }> =
    report.kpis && report.kpis.length
      ? report.kpis.map((k) => ({ label: k.label, value: k.value, delta: k.delta }))
      : report.kpi ?? []

  const be = report.breakeven
  const todos = report.todos ?? []
  const alerts = report.alerts ?? []
  const lowStock = report.low_stock?.items ?? []

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <Text type="secondary" style={{ fontSize: 12 }}>{report.range_label || '今日'}</Text>
        <Title level={4} style={{ margin: '4px 0 12px' }}>
          {greeting()}，老板
        </Title>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          {kpis.slice(0, 4).map((k) => (
            <div key={k.label} style={{ background: '#fafafa', borderRadius: 12, padding: '12px 10px' }}>
              <div style={{ fontSize: 11, color: COLORS.gray }}>{k.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4 }}>{k.value}</div>
              {k.delta && (
                <div
                  style={{
                    fontSize: 11,
                    marginTop: 2,
                    color: String(k.delta).startsWith('-') ? COLORS.green : COLORS.red,
                  }}
                >
                  {k.delta}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {be && (
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text strong style={{ fontSize: 13 }}>
              <FundOutlined style={{ marginRight: 6, color: COLORS.purple }} />
              今日保本线
            </Text>
            <Text strong style={{ fontSize: 18 }}>{fmt(be.be_day)}</Text>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1, background: '#fafafa', borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 11, color: COLORS.gray }}>今日已收</div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{fmt(be.today_rev)}</div>
            </div>
            <div style={{ flex: 1, background: '#fafafa', borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 11, color: COLORS.gray }}>保本达成</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: (be.attain_pct ?? 0) >= 100 ? COLORS.green : COLORS.red }}>
                {be.attain_pct == null ? '-' : `${Math.round(be.attain_pct)}%`}
              </div>
            </div>
          </div>
        </Card>
      )}

      {todos.length > 0 && (
        <div>
          <SectionTitle icon={<CheckCircleOutlined style={{ color: COLORS.green }} />} title={`待办 ${todos.length}`} />
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {todos.slice(0, 6).map((t, i) => (
                <div key={t.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      background: COLORS.yellow,
                      flexShrink: 0,
                    }}
                  />
                  <Text style={{ fontSize: 13, flex: 1 }}>{t.title || t.text || t.desc}</Text>
                  {t.route && <RightOutlined style={{ color: '#bbb', fontSize: 12 }} />}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {alerts.length > 0 && (
        <div>
          <SectionTitle icon={<AlertOutlined style={{ color: COLORS.red }} />} title={`预警 ${alerts.length}`} />
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {alerts.slice(0, 6).map((a, i) => (
                <div key={a.id ?? i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <WarningOutlined style={{ color: a.level === 'critical' ? COLORS.red : COLORS.orange }} />
                  <Text style={{ fontSize: 13, flex: 1 }}>{a.title || a.text || a.detail}</Text>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {lowStock.length > 0 && (
        <div>
          <SectionTitle
            title={`低库存 ${report.low_stock?.total ?? lowStock.length}`}
            extra={<Button type="link" size="small" onClick={() => onOpenModule(moduleByKey('inventory/restock')!)}>去补货</Button>}
          />
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lowStock.slice(0, 6).map((it, i) => (
                <div key={it.id ?? i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <Text>{it.name}</Text>
                  <Text type="secondary">{it.qty ?? '-'} / {it.safe ?? '-'} {it.unit ?? ''}</Text>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}
    </div>
  )
}

function FrontTab({ onOpenModule }: { onOpenModule: (m: MobileModule) => void }) {
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PipeView pipe={FRONT_PIPE} />
      <div>
        <SectionTitle title="前厅模块" />
        <ModuleGrid keys={FRONT_MODULE_KEYS} onOpen={onOpenModule} />
      </div>
    </div>
  )
}

function SiTab({ onOpenDesktop }: { onOpenDesktop: (p?: string) => void }) {
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 16,
              background: COLORS.aiGradient,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 26,
              flexShrink: 0,
            }}
          >
            <RobotOutlined />
          </div>
          <div>
            <Title level={5} style={{ margin: 0 }}>SI · 问店决策</Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              只看不算钱 · 改数一律走「确认台」留痕
            </Text>
          </div>
        </div>
      </Card>

      <div>
        <SectionTitle title="快捷问句（跳真数据页）" />
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SI_PROMPTS.map((p) => (
              <div
                key={p.label}
                onClick={() => p.desktopPath && onOpenDesktop(p.desktopPath)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: '#fafafa',
                  cursor: p.desktopPath ? 'pointer' : 'default',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</div>
                  <div style={{ fontSize: 11, color: COLORS.gray }}>{p.hint}</div>
                </div>
                {p.desktopPath && <RightOutlined style={{ color: '#bbb' }} />}
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Text type="secondary" style={{ fontSize: 11, textAlign: 'center' }}>
        手机端 SI 对话能力待接 Kimi 接口 · 当前以快捷入口代替
      </Text>
    </div>
  )
}

function KitchenTab({ onOpenModule }: { onOpenModule: (m: MobileModule) => void }) {
  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <PipeView pipe={KITCHEN_PIPE} />
      <div>
        <SectionTitle title="后厨模块" />
        <ModuleGrid keys={KITCHEN_MODULE_KEYS} onOpen={onOpenModule} />
      </div>
    </div>
  )
}

function MoreTab({
  stores,
  onStoreChange,
  onOpenModule,
  onOpenDesktop,
  onLogout,
}: {
  stores: OrgStore[]
  onStoreChange: (id: string) => void
  onOpenModule: (m: MobileModule) => void
  onOpenDesktop: (p?: string) => void
  onLogout: () => void
}) {
  const { role, account, storeName, storeId } = useAuthStore()

  const storeItems: MenuProps['items'] = useMemo(
    () =>
      (stores.length ? stores : storeId ? [{ id: storeId, name: storeName || storeId }] : []).map(
        (s) => ({ key: s.id, label: s.name }),
      ),
    [stores, storeId, storeName],
  )

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              background: COLORS.aiGradient,
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 20,
              flexShrink: 0,
            }}
          >
            <UserOutlined />
          </div>
          <div style={{ flex: 1 }}>
            <Text strong style={{ fontSize: 15 }}>{account}</Text>
            <div style={{ fontSize: 12, color: COLORS.gray, marginTop: 2 }}>
              <Tag color="purple" style={{ marginInlineEnd: 6 }}>{role}</Tag>
              {storeName || '未选门店'}
            </div>
          </div>
          <Button type="text" size="small" icon={<DesktopOutlined />} onClick={() => onOpenDesktop('/dashboard')} />
        </div>
        <div style={{ marginTop: 12 }}>
          <Dropdown
            menu={{ items: storeItems, onClick: ({ key }) => onStoreChange(key) }}
            trigger={['click']}
          >
            <Button block icon={<ShopOutlined />} style={{ textAlign: 'left' }}>
              <span style={{ flex: 1 }}>{storeName || '选择门店'}</span>
              <DownOutlined style={{ fontSize: 10, color: '#bbb' }} />
            </Button>
          </Dropdown>
        </div>
      </Card>

      {GROUP_ORDER.map((g) => {
        const list = modulesIn(g)
        if (!list.length) return null
        return (
          <div key={g}>
            <SectionTitle
              title={g}
              extra={<Text type="secondary" style={{ fontSize: 10 }}>{GROUP_HINT[g]}</Text>}
            />
            <ModuleGrid keys={list.map((m) => m.key)} onOpen={onOpenModule} />
          </div>
        )
      })}

      <Button block danger icon={<LogoutOutlined />} onClick={onLogout} style={{ marginTop: 8 }}>
        退出登录 · 切换账号/门店
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 手机壳 + 外壳                                                       */
/* ------------------------------------------------------------------ */

const TAB_ICONS: Record<TabKey, React.ReactNode> = {
  今日: <HomeOutlined />,
  前厅: <ShopOutlined />,
  SI: <RobotOutlined />,
  后厨: <FireOutlined />,
  我的: <UserOutlined />,
}

export default function MobileApp() {
  const navigate = useNavigate()
  const { logout, storeId, setStore, storeName } = useAuthStore()

  const [tab, setTab] = useState<TabKey>('今日')
  const [activeModule, setActiveModule] = useState<MobileModule | null>(null)
  const [stores, setStores] = useState<OrgStore[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [report, setReport] = useState<ReportDaily | null>(null)
  const [loadingReport, setLoadingReport] = useState(true)

  useEffect(() => {
    let alive = true
    fetchOrg()
      .then((o) => {
        if (!alive) return
        setStores(o.stores || [])
        if (!storeId && o.stores?.[0]) setStore({ storeId: o.stores[0].id, storeName: o.stores[0].name })
      })
      .catch(() => alive && setStores([]))
    fetchHealth()
      .then((h) => alive && setHealth(h))
      .catch(() => alive && setHealth(null))
    return () => {
      alive = false
    }
  }, [storeId, setStore])

  useEffect(() => {
    let alive = true
    setLoadingReport(true)
    fetchReportDaily()
      .then((r) => alive && setReport(r))
      .catch(() => alive && setReport(null))
      .finally(() => alive && setLoadingReport(false))
    return () => {
      alive = false
    }
  }, [storeId])

  const openDesktop = useCallback((p?: string) => {
    if (p) window.open(p, '_blank')
  }, [])

  const onStoreChange = (id: string) => {
    const s = stores.find((x) => x.id === id)
    if (!s) return
    setStore({ storeId: s.id, storeName: s.name })
    message.success(`已切换门店：${s.name}`)
  }

  const onLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const openModule = (m: MobileModule) => setActiveModule(m)

  const content = activeModule ? (
    activeModule.key === 'm/inspection' ? (
      <InspectionFlow onBack={() => setActiveModule(null)} />
    ) : (
      <ModuleDetail m={activeModule} onBack={() => setActiveModule(null)} onOpenDesktop={openDesktop} />
    )
  ) : tab === '今日' ? (
    <TodayTab report={report} loading={loadingReport} onOpenModule={openModule} />
  ) : tab === '前厅' ? (
    <FrontTab onOpenModule={openModule} />
  ) : tab === 'SI' ? (
    <SiTab onOpenDesktop={openDesktop} />
  ) : tab === '后厨' ? (
    <KitchenTab onOpenModule={openModule} />
  ) : (
    <MoreTab
      stores={stores}
      onStoreChange={onStoreChange}
      onOpenModule={openModule}
      onOpenDesktop={openDesktop}
      onLogout={onLogout}
    />
  )

  return (
    <div className="m-viewport">
      <div className="m-shell">
        {/* 状态栏 */}
        <div className="m-statusbar">
          <Text style={{ color: '#fff', fontSize: 12 }}>{new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</Text>
          <Text style={{ color: '#fff', fontSize: 11 }}>{health ? `rev ${health.rev ?? '-'}` : 'BFF 离线'}</Text>
        </div>

        {/* 品牌头 + 门店切换 */}
        <div className="m-header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ai-gradient-text" style={{ fontSize: 17, fontWeight: 700 }}>熊猫五福</div>
            <Text type="secondary" style={{ fontSize: 11 }}>{storeName || '手机版预览'}</Text>
          </div>
          <Dropdown
            menu={{
              items: (stores.length ? stores : storeId ? [{ id: storeId, name: storeName || storeId }] : []).map(
                (s) => ({ key: s.id, label: s.name }),
              ),
              onClick: ({ key }) => onStoreChange(key),
            }}
            trigger={['click']}
          >
            <Button size="small" icon={<ShopOutlined />}>
              {storeName || '切店'}
              <DownOutlined style={{ fontSize: 10, color: '#bbb' }} />
            </Button>
          </Dropdown>
          <Button type="text" size="small" icon={<DesktopOutlined />} onClick={() => openDesktop('/dashboard')} />
        </div>

        {/* 内容区 */}
        <div className="m-content">
          {!activeModule && (
            <div style={{ padding: '12px 12px 0' }}>
              <Text strong style={{ fontSize: 20, display: 'block' }}>{tab}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>{TAB_SUB[tab]}</Text>
            </div>
          )}
          {content}
        </div>

        {/* 底栏 */}
        <div className="m-bottomnav">
          {TAB_ORDER.map((t) => {
            const active = t === tab && !activeModule
            return (
              <div
                key={t}
                onClick={() => {
                  setActiveModule(null)
                  setTab(t)
                }}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 2,
                  padding: '6px 0',
                  cursor: 'pointer',
                  color: active ? COLORS.purple : '#999',
                }}
              >
                <span style={{ fontSize: 20, lineHeight: 1 }}>{TAB_ICONS[t]}</span>
                <span style={{ fontSize: 11 }}>{t}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
