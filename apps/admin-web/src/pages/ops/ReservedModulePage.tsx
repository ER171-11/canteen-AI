import { useEffect, useState } from 'react'
import { Alert, Card, Col, Row, Spin, Tag, Typography } from 'antd'
import { client } from '../../api/client'

/*
 * 前厅接口预留总览（与美团深度合作）。
 * 会员营销(M3) / 堂食收银(M5) / 外卖平台(M6) / 预订排队(M7) / 顾客口碑(M11)
 * 当前由美团承接，相关 /api/<prefix> 仅返回预留契约、不接业务、不写库。
 * 置 BFF 环境变量 FRONT_OF_HOUSE_PROVIDER=self 后可切回自营（reserved 路由改走真实只读层）。
 */
const MODULES = [
  { prefix: 'vip', name: '会员营销', doc: 'M3' },
  { prefix: 'pos', name: '堂食收银', doc: 'M5' },
  { prefix: 'takeout', name: '外卖平台', doc: 'M6' },
  { prefix: 'booking', name: '预订排队', doc: 'M7' },
  { prefix: 'review', name: '顾客口碑', doc: 'M11' },
]

interface ReservedInfo {
  provider?: string
  status?: string
  switchable?: boolean
  module?: string
  note?: string
}

export default function ReservedModulePage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<Record<string, ReservedInfo>>({})

  useEffect(() => {
    let alive = true
    Promise.all(
      MODULES.map((m) =>
        client
          .get('/' + m.prefix)
          .then((r) => [m.prefix, (r.data && r.data.data) || {}] as const)
          .catch(() => [m.prefix, {}] as const),
      ),
    )
      .then((pairs) => {
        if (!alive) return
        const obj: Record<string, ReservedInfo> = {}
        for (const [k, v] of pairs) obj[k] = v
        setData(obj)
        setLoading(false)
      })
      .catch((e) => {
        if (alive) {
          setErr(String(e))
          setLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div style={{ padding: 16 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        前厅接口预留总览
      </Typography.Title>
      <Alert
        style={{ margin: '12px 0' }}
        type="info"
        showIcon
        message="前厅运营由美团承接，接口已预留"
        description="会员营销 / 堂食收银 / 外卖平台 / 预订排队 / 顾客口碑 当前走美团，相关接口仅预留、不接业务、不写库。置 BFF 环境变量 FRONT_OF_HOUSE_PROVIDER=self 后可切回自营（reserved 路由改走真实只读层、前厅写回动作允许消费）。"
      />
      {loading && <Spin tip="加载中" />}
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
      <Row gutter={16}>
        {MODULES.map((m) => {
          const info = data[m.prefix] || {}
          const reserved = info.provider === 'meituan'
          return (
            <Col xs={24} md={12} lg={8} key={m.prefix} style={{ marginTop: 16 }}>
              <Card size="small" title={<span>{m.name} <Tag>{m.doc}</Tag></span>}>
                <p>
                  接口：<Typography.Text code>/api/{m.prefix}</Typography.Text>
                </p>
                <p>
                  承接方：
                  {reserved ? <Tag color="orange">美团 meituan</Tag> : <Tag color="green">自营 self</Tag>}
                </p>
                <p>
                  状态：
                  {info.status === 'reserved' ? (
                    <Tag color="blue">接口预留</Tag>
                  ) : (
                    <Typography.Text>{info.status || '—'}</Typography.Text>
                  )}
                </p>
                <p>可切换：{info.switchable ? '是' : '否'}</p>
                {info.note && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {info.note}
                  </Typography.Text>
                )}
              </Card>
            </Col>
          )
        })}
      </Row>
    </div>
  )
}
