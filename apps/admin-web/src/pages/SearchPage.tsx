import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, Empty, Input, List, Space, Spin, Tabs, Tag, Typography, message } from 'antd'
import { SearchOutlined } from '@ant-design/icons'
import { fetchSearchAll, fetchSearchDomains } from '../api'
import type { SearchAllResp, SearchDomainMeta, SearchHit } from '../api/types'
import { COLORS } from '../theme'

const { Text } = Typography

/** 业务类型 → 目标页面深链（命中后点击跳转对应模块） */
const KIND_PATH: Record<string, string> = {
  原料: '/inventory/stock',
  菜谱: '/kitchen/recipes',
  供应商: '/inventory/vendors',
  报价: '/inventory/vendors',
  进货单: '/inventory/inbound',
  往来账: '/inventory/vendors',
  发票: '/finance/invoice',
  证照: '/safety/licenses',
  留样: '/safety/sample',
  消毒: '/safety/points',
  员工: '/hr/roster',
  设备: '/safety/devices',
  销售单: '/dinein/sales',
}

const KIND_COLOR: Record<string, string> = {
  原料: COLORS.green,
  菜谱: COLORS.purple,
  供应商: COLORS.blue,
  报价: COLORS.blue,
  进货单: COLORS.orange,
  往来账: COLORS.yellow,
  发票: COLORS.red,
  证照: COLORS.red,
  留样: COLORS.green,
  消毒: COLORS.green,
  员工: COLORS.purple,
  设备: COLORS.indigo,
  销售单: COLORS.blue,
}

/** 标题里高亮命中片段 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <span style={{ background: '#FFF3B0', fontWeight: 700, borderRadius: 2, padding: '0 1px' }}>
        {text.slice(idx, idx + q.length)}
      </span>
      {text.slice(idx + q.length)}
    </>
  )
}

function HitRow({ hit, q, onOpen }: { hit: SearchHit; q: string; onOpen: () => void }) {
  const path = KIND_PATH[hit.kind]
  return (
    <List.Item
      onClick={onOpen}
      style={{ cursor: path ? 'pointer' : 'default', padding: '10px 4px' }}
    >
      <List.Item.Meta
        title={
          <Space size={8} wrap>
            <Tag color={KIND_COLOR[hit.kind] ?? 'default'} style={{ marginInlineEnd: 0 }}>
              {hit.kind}
            </Tag>
            <Text strong>
              <Highlight text={hit.title} q={q} />
            </Text>
            {hit.subtitle ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {hit.subtitle}
              </Text>
            ) : null}
          </Space>
        }
        description={
          <span style={{ fontSize: 12, color: '#999' }}>
            命中字段 <Tag style={{ marginInlineStart: 4 }}>{hit.matched_field}</Tag>
            {path ? ' · 点击跳转对应模块' : ''}
          </span>
        }
      />
    </List.Item>
  )
}

function HitList({ hits, q, onOpen }: { hits: SearchHit[]; q: string; onOpen: (hit: SearchHit) => void }) {
  return (
    <List
      size="small"
      dataSource={hits}
      locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该域无命中" /> }}
      renderItem={(hit) => <HitRow hit={hit} q={q} onOpen={() => onOpen(hit)} />}
    />
  )
}

export default function SearchPage() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const [input, setInput] = useState(q)
  const [activeDomain, setActiveDomain] = useState('all')
  const [domains, setDomains] = useState<SearchDomainMeta[]>([])
  const [resp, setResp] = useState<SearchAllResp | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  /* URL ?q= 变化时同步输入框 */
  useEffect(() => setInput(q), [q])

  /* 拉取域枚举（tab 顺序与中文标签以后端为准） */
  useEffect(() => {
    fetchSearchDomains()
      .then((d) => setDomains(d.domains ?? []))
      .catch(() => setDomains([]))
  }, [])

  /* 关键词变化时执行全局分域检索（单请求返回 6 域分组，各 tab 独立渲染） */
  useEffect(() => {
    if (!q) {
      setResp(null)
      setLoading(false)
      setError(false)
      return
    }
    let alive = true
    setLoading(true)
    setError(false)
    fetchSearchAll(q)
      .then((r) => {
        if (!alive) return
        setResp(r)
        setActiveDomain('all')
      })
      .catch(() => {
        if (!alive) return
        setError(true)
        message.error('检索失败，请确认后端服务可用')
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [q])

  const onSearch = (value: string) => {
    const v = value.trim()
    if (v) setParams({ q: v })
  }

  const openHit = (hit: SearchHit) => {
    const path = KIND_PATH[hit.kind]
    if (path) navigate(path)
  }

  const tabItems = useMemo(() => {
    const countOf = (key: string) => resp?.domains?.[key]?.count ?? 0
    const items: { key: string; label: React.ReactNode }[] = [
      { key: 'all', label: `全部（${resp?.total ?? 0}）` },
    ]
    for (const d of domains) {
      items.push({ key: d.key, label: `${d.label}（${countOf(d.key)}）` })
    }
    return items
  }, [domains, resp])

  const domainResults = useMemo(() => {
    if (!resp) return []
    return resp.domain_order
      .map((key) => resp.domains[key])
      .filter((d) => d && d.count > 0)
  }, [resp])

  return (
    <div>
      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input.Search
            allowClear
            enterButton
            size="large"
            prefix={<SearchOutlined style={{ color: '#bbb' }} />}
            placeholder="全局检索：原料 / 菜谱 / 供应商 / 发票 / 员工 / 销售单…（仅索引非敏感字段）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onSearch={onSearch}
            autoFocus
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            检索域隔离：各业务域独立返回、互不串味；税号 / 内部编码 / 成本价 / 金额 / 薪资 / 身份证 / 银行账号等敏感字段不进入搜索索引。
          </Text>
        </Space>
      </Card>

      <Card>
        <Tabs activeKey={activeDomain} onChange={setActiveDomain} items={tabItems} />

        {loading ? (
          <div style={{ textAlign: 'center', padding: '48px 0' }}>
            <Spin size="large" />
            <div style={{ marginTop: 12, color: '#999' }}>检索中…</div>
          </div>
        ) : !q ? (
          <Empty description="输入关键词开始全局检索" style={{ padding: '48px 0' }} />
        ) : error ? (
          <Empty description="检索失败（后端离线？）" style={{ padding: '48px 0' }} />
        ) : resp && resp.total === 0 ? (
          <Empty description={`未检索到与「${q}」相关的记录`} style={{ padding: '48px 0' }} />
        ) : resp && activeDomain === 'all' ? (
          <div>
            {domainResults.map((d) => (
              <div key={d.domain} style={{ marginBottom: 20 }}>
                <div style={{ marginBottom: 8 }}>
                  <Tag color={COLORS.black} style={{ fontWeight: 600 }}>
                    {d.label}
                  </Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {d.count} 条命中
                  </Text>
                </div>
                <HitList hits={d.hits} q={q} onOpen={openHit} />
              </div>
            ))}
          </div>
        ) : resp ? (
          <HitList hits={resp.domains[activeDomain]?.hits ?? []} q={q} onOpen={openHit} />
        ) : null}
      </Card>
    </div>
  )
}
