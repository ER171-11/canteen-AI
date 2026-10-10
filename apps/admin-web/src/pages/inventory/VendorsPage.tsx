import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import type { Dayjs } from 'dayjs'
import {
  fetchSupplyVendors,
  fetchSupplyCompare,
  fetchSupplyAccounts,
  fetchSupplyOverview,
  fetchSupplyConfig,
  fetchAdminPrice,
  saveSupplyConfig,
  upsertSupplyVendor,
  logSupplyQuote,
  logSupplyPo,
} from '../../api'
import type {
  PricePlanItem,
  PriceReportRow,
  PriceResp,
  SupplyAccountRow,
  SupplyAccountsResp,
  SupplyCompareResp,
  SupplyConfigResp,
  SupplyOverviewResp,
  SupplyVendorRow,
  SupplyVendorsResp,
} from '../../api/types'
import { useAuthStore } from '../../store/auth'
import { client } from '../../api/client'
import { comparePlatformUrl, DEF_COMPARE_PLATFORMS, normalizeComparePlatforms } from './comparePlatforms'
import type { ComparePlatform } from './comparePlatforms'
import { COLORS } from '../../theme'

type SupplyTab = 'vendors' | 'compare' | 'accounts' | 'price'
type PriceFilter = 'all' | 'better' | 'worse' | 'none'

const DEFAULT_CFG: SupplyConfigResp['supply'] = {
  spread_warn_pct: 10,
  aging_over30_d: 30,
  aging_over60_d: 60,
  low_level: 3,
}

export default function VendorsPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const [vendors, setVendors] = useState<SupplyVendorsResp | null>(null)
  const [compare, setCompare] = useState<SupplyCompareResp | null>(null)
  const [accounts, setAccounts] = useState<SupplyAccountsResp | null>(null)
  const [overview, setOverview] = useState<SupplyOverviewResp | null>(null)
  const [cfg, setCfg] = useState<SupplyConfigResp['supply']>(DEFAULT_CFG)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<SupplyTab>('vendors')
  const [price, setPrice] = useState<PriceResp | null>(null)
  const [priceQ, setPriceQ] = useState('')
  const [priceF, setPriceF] = useState<PriceFilter>('all')
  const [planOpen, setPlanOpen] = useState(false)
  /* FP-PRICE-09：「去比价」外链所用的平台表（`config.compare_platforms`，缺省用旧版 DEF_PLATFORMS） */
  const [platforms, setPlatforms] = useState<ComparePlatform[]>(DEF_COMPARE_PLATFORMS.map((p) => ({ ...p })))

  const [vOpen, setVOpen] = useState(false)
  const [vForm] = Form.useForm()
  const [qOpen, setQOpen] = useState(false)
  const [qForm] = Form.useForm()
  const [poOpen, setPoOpen] = useState(false)
  const [poForm] = Form.useForm()
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfgForm] = Form.useForm()

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetchSupplyVendors(),
      fetchSupplyCompare(),
      fetchSupplyAccounts(),
      fetchSupplyOverview(),
      fetchSupplyConfig().catch(() => null),
      fetchAdminPrice().catch(() => null),
      client.get<{ config?: Record<string, unknown> }>('/admin/config').catch(() => null),
    ])
      .then(([v, c, a, o, cf, pr, cfg]) => {
        setVendors(v)
        setCompare(c)
        setAccounts(a)
        setOverview(o)
        if (cf?.supply) setCfg(cf.supply)
        if (pr) setPrice(pr)
        if (cfg?.data?.config) setPlatforms(normalizeComparePlatforms(cfg.data.config.compare_platforms))
        setIsMock(false)
      })
      .catch(() => {
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const vCols: ColumnsType<SupplyVendorRow> = useMemo(
    () => [
      { title: '供应商', dataIndex: 'name', width: 150, render: (x) => <strong>{x}</strong> },
      { title: '品类', dataIndex: 'category', width: 100, render: (x) => <Tag color={COLORS.blue}>{x}</Tag> },
      { title: '账期', dataIndex: 'period', width: 110 },
      {
        title: '评级',
        dataIndex: 'level',
        width: 110,
        render: (x) => (x == null ? '-' : <Tag color={Number(x) < cfg.low_level ? COLORS.red : COLORS.green}>{x} 星</Tag>),
      },
      { title: '状态', dataIndex: 'status', width: 100, render: (x) => <Tag>{x}</Tag> },
      { title: '联系人', dataIndex: 'contact', width: 110, render: (x) => x ?? '-' },
      { title: '电话', dataIndex: 'phone', width: 140, render: (x) => x ?? '-' },
    ],
    [cfg.low_level],
  )

  const cmpCols: ColumnsType<SupplyCompareResp['rows'][number]> = useMemo(
    () => [
      { title: '原料', dataIndex: 'name', width: 140, render: (x) => <strong>{x}</strong> },
      { title: '候选数', dataIndex: 'candidates', width: 90 },
      { title: '最低价', key: 'best', width: 150, render: (_, r) => <span style={{ color: COLORS.green }}>{r.best.src} ¥{r.best.price}</span> },
      { title: '最高价', key: 'worst', width: 150, render: (_, r) => <span style={{ color: COLORS.red }}>{r.worst.src} ¥{r.worst.price}</span> },
      {
        title: '价差',
        dataIndex: 'spread_pct',
        width: 100,
        sorter: (a, b) => (a.spread_pct ?? 0) - (b.spread_pct ?? 0),
        render: (x) => (x == null ? '-' : <Tag color={x > (compare?.warn_pct ?? 10) ? COLORS.orange : COLORS.gray}>{x}%</Tag>),
      },
    ],
    [compare],
  )

  const accCols: ColumnsType<SupplyAccountRow> = useMemo(
    () => [
      { title: '供应商', dataIndex: 'supplier', width: 150, render: (x) => <strong>{x}</strong> },
      { title: '类型', dataIndex: 'kind', width: 90, render: (x) => <Tag>{x}</Tag> },
      { title: '应付余额', dataIndex: 'balance', width: 120, align: 'right', render: (x) => `¥${x}` },
      { title: '到期日', dataIndex: 'due', width: 120, render: (x) => x ?? '-' },
      { title: '状态', dataIndex: 'status', width: 110, render: (x) => <Tag color={/逾期/.test(String(x)) ? COLORS.red : COLORS.gray}>{x || '-'}</Tag> },
    ],
    [],
  )

  /* FP-PRICE-03 比价主表：本店均价 vs 外部最低报价（差价 / 节省%） */
  const priceCols: ColumnsType<PriceReportRow> = useMemo(
    () => [
      {
        title: '原料', dataIndex: 'name', width: 170,
        render: (x, r) => (
          <>
            <strong>{x}</strong>
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
              {r.cat}{r.conv !== 1 ? ` · 1${r.buy}=${r.conv}${r.unit}` : ''}
            </Typography.Text>
          </>
        ),
      },
      { title: '本店均价', dataIndex: 'avg', width: 100, align: 'right', render: (x, r) => `¥${x}/${r.unit}` },
      {
        title: '外部最低报价', key: 'best', width: 170,
        render: (_, r) => r.best
          ? <span><strong style={{ color: COLORS.green }}>¥{r.best.unit}/{r.unit}</strong><Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>{r.best.src} ¥{r.best.price}/{r.best.per === 'buy' ? r.buy : r.unit}</Typography.Text></span>
          : <Typography.Text type="secondary">暂无报价</Typography.Text>,
      },
      {
        title: '差价', dataIndex: 'diff', width: 100, align: 'right',
        sorter: (a, b) => (a.diff ?? 0) - (b.diff ?? 0),
        render: (x) => x == null ? '-' : <span style={{ color: x < 0 ? COLORS.green : COLORS.red }}>{x > 0 ? '+' : ''}{x}</span>,
      },
      {
        title: '节省%', dataIndex: 'savePct', width: 100, align: 'right',
        sorter: (a, b) => (a.savePct ?? 0) - (b.savePct ?? 0),
        render: (x, r) => x == null ? '-' : <Tag color={r.diff! < 0 ? COLORS.green : COLORS.red}>{r.diff! < 0 ? '省' : '高'} {x}%</Tag>,
      },
      {
        title: '来源与时间', key: 'recent', width: 200,
        render: (_, r) => r.best
          ? (
            <>
              <Tag color={r.diff! < -0.01 ? COLORS.green : r.diff! > 0.01 ? COLORS.red : COLORS.gray}>{r.diff! < -0.01 ? '外价更低' : r.diff! > 0.01 ? '外价更高' : '基本持平'}</Tag>
              {r.recent.slice(0, 2).map((q, i) => (
                <Typography.Text key={i} type="secondary" style={{ fontSize: 12, display: 'block' }}>{q.src} · {q.date}</Typography.Text>
              ))}
            </>
          )
          : <Typography.Text type="secondary">无</Typography.Text>,
      },
      {
        /* FP-PRICE-09：跳转外部平台搜索（旧版 pricePop，HTML:1178-1182） */
        title: '去比价', key: 'go', width: 110,
        render: (_, r) => (
          <Dropdown
            menu={{
              items: platforms.length
                ? platforms.map((p) => ({
                    key: p.name || p.tpl,
                    label: (
                      <a href={comparePlatformUrl(p.tpl, r.name)} target="_blank" rel="noopener noreferrer">
                        🔍 {p.name || p.tpl}
                      </a>
                    ),
                  }))
                : [{ key: 'none', label: '未配置平台（到「设置」添加）', disabled: true }],
            }}
          >
            <Button size="small">去比价</Button>
          </Dropdown>
        ),
      },
    ],
    [platforms],
  )

  /* FP-PRICE-13 待比价清单 */
  const planCols: ColumnsType<PricePlanItem> = useMemo(
    () => [
      { title: '原料', dataIndex: 'name', width: 140, render: (x) => <strong>{x}</strong> },
      { title: '分类', dataIndex: 'cat', width: 90, render: (x) => <Tag color={COLORS.blue}>{x}</Tag> },
      { title: '建议搜索关键词', dataIndex: 'keyword', width: 160 },
      { title: '采购单位换算', key: 'conv', width: 120, render: (_, r) => `1${r.buy} = ${r.conv}${r.unit}` },
      { title: '本店均价', dataIndex: 'avg', width: 100, align: 'right', render: (x, r) => `¥${x}/${r.unit}` },
      { title: '状态', dataIndex: 'status', width: 100, render: (x) => <Tag color={x === '已比价' ? COLORS.green : COLORS.orange}>{x}</Tag> },
    ],
    [],
  )

  const priceRows = useMemo(() => {
    if (!price) return []
    return price.report.rows.filter((r) => {
      if (priceQ && !r.name.includes(priceQ) && !r.cat.includes(priceQ)) return false
      if (priceF === 'better') return r.best != null && (r.diff ?? 0) < -0.01
      if (priceF === 'worse') return r.best != null && (r.diff ?? 0) > 0.01
      if (priceF === 'none') return r.best == null
      return true
    })
  }, [price, priceQ, priceF])

  const run = async (fn: () => Promise<{ ok?: boolean; note?: string; error?: string }>, close: () => void, okMsg: string) => {
    setBusy(true)
    try {
      const res = await fn()
      if (res.ok) { message.success(res.note || okMsg); close(); load() }
      else message.error(res.error || '操作失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const submitVendor = async () => {
    const v = await vForm.validateFields()
    await run(() => upsertSupplyVendor({
      name: v.name, vendor_id: v.vendor_id || undefined, category: v.category, period: v.period,
      level: v.level == null ? undefined : Number(v.level), status: v.status, contact: v.contact, phone: v.phone, note: v.note,
    }), () => setVOpen(false), '供应商档案已入队')
  }
  /* FP-PRICE-05 报价口径实时折算（口径同 bff/lib/price.js::quotePerStock：
     per='buy' 按采购单位价 ÷ conv，'stock' 即库存单位价），对比本店均价给「低/高」提示 */
  const qIng = Form.useWatch('ing', qForm)
  const qPrice = Form.useWatch('price', qForm)
  const qPer = Form.useWatch('per', qForm)
  const qRows = price?.report.rows ?? []
  const qRow = useMemo(() => qRows.find((r) => r.name === qIng) || null, [qRows, qIng])
  const qHint = useMemo(() => {
    if (!qRow) return null
    const p = Number(qPrice) || 0
    if (p <= 0) return null
    const conv = qRow.conv > 0 ? qRow.conv : 1
    const unit = qPer === 'buy' ? p / conv : p
    const avg = Number(qRow.avg) || 0
    const diff = unit - avg
    const pct = avg > 0 ? (Math.abs(diff) / avg) * 100 : 0
    return { unit, avg, diff, pct, unitName: qRow.unit, buy: qRow.buy, conv: qRow.conv }
  }, [qRow, qPrice, qPer])

  const submitQuote = async () => {
    const v = await qForm.validateFields()
    await run(() => logSupplyQuote({
      ing: v.ing, src: v.src, price: Number(v.price), per: v.per, unit: v.unit, note: v.note, set_default_sup: v.set_default_sup === true,
    }), () => setQOpen(false), '报价已入队')
  }
  const submitPo = async () => {
    const v = await poForm.validateFields()
    await run(() => logSupplyPo({
      vendor_id: v.vendor_id, amount: Number(v.amount), ref_no: v.ref_no || undefined,
      ts: v.ts ? (v.ts as Dayjs).format('YYYY-MM-DD') : undefined,
    }), () => setPoOpen(false), '采购应付已入队')
  }
  const submitCfg = async () => {
    const v = await cfgForm.validateFields()
    setBusy(true)
    try {
      const res = await saveSupplyConfig({
        spread_warn_pct: Number(v.spread_warn_pct),
        aging_over30_d: Number(v.aging_over30_d),
        aging_over60_d: Number(v.aging_over60_d),
        low_level: Number(v.low_level),
      })
      if (res.ok) { setCfg(res.supply); message.success('供应链配置已保存'); setCfgOpen(false); load() }
      else message.error('保存失败')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败')
    } finally {
      setBusy(false)
    }
  }
  const openCfg = () => { cfgForm.setFieldsValue({ ...cfg }); setCfgOpen(true) }
  const tip = canWrite ? undefined : '当前角色无写权限，仅可查看'

  const aging = accounts?.aging

  return (
    <div>
      {isMock && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="后端 /api/supply 未连通，当前为本地样例数据" />}
      {(overview?.alerts ?? []).slice(0, 4).map((a, i) => (
        <Alert key={i} type={a.level === 'red' ? 'error' : a.level === 'orange' ? 'warning' : 'info'} showIcon style={{ marginBottom: 12 }} message={a.text} />
      ))}

      <Card
        title="供应链 · 供应商 / 比价 / 往来账"
        extra={
          <Space wrap>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={openCfg}>配置</Button></Tooltip>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={() => { vForm.resetFields(); vForm.setFieldsValue({ status: '合作中', period: '月结30天', level: 3 }); setVOpen(true) }}>供应商登记</Button></Tooltip>
            <Tooltip title={tip}><Button disabled={!canWrite} onClick={() => { qForm.resetFields(); setQOpen(true) }}>报价登记</Button></Tooltip>
            <Tooltip title={tip}><Button type="primary" disabled={!canWrite} onClick={() => { poForm.resetFields(); setPoOpen(true) }}>采购应付</Button></Tooltip>
            <Button size="small" onClick={load}>刷新</Button>
          </Space>
        }
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="供应商" value={overview?.vendors.count ?? 0} suffix="家" /><Typography.Text type="secondary" style={{ fontSize: 12 }}>低评级 {overview?.vendors.low_rated ?? 0} 家</Typography.Text></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="可比价原料" value={overview?.compare.available ?? 0} suffix="项" /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{overview?.compare.top ? `最大价差 ${overview.compare.top.spread_pct}%（${overview.compare.top.name}）` : '暂无价差'}</Typography.Text></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="应付总额" value={overview?.accounts.payable ?? 0} prefix="¥" /></Card>
          </Col>
          <Col xs={12} md={6}>
            <Card size="small"><Statistic title="需结算（>60天/逾期）" value={overview?.accounts.need_settle ?? 0} prefix="¥" valueStyle={{ color: (overview?.accounts.need_settle ?? 0) > 0 ? COLORS.red : COLORS.green }} /></Card>
          </Col>
        </Row>

        <Tabs
          activeKey={tab}
          onChange={(k) => setTab(k as SupplyTab)}
          items={[
            {
              key: 'vendors',
              label: `供应商档案（${vendors?.count ?? 0}）`,
              children: vendors?.rows.length ? (
                <Table<SupplyVendorRow> rowKey={(r) => String(r.id ?? r.name)} columns={vCols} dataSource={vendors.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
              ) : <Empty description="暂无供应商档案" />,
            },
            {
              key: 'compare',
              label: `比价（${compare?.available ?? 0}）`,
              children: compare?.rows.length ? (
                <>
                  <Typography.Paragraph type="secondary">按报价最低为最优候选；AI 仅建议，切换供应商需确认。</Typography.Paragraph>
                  <Table<SupplyCompareResp['rows'][number]> rowKey={(r) => r.name} columns={cmpCols} dataSource={compare.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                </>
              ) : <Empty description="暂无多供应商报价样本" />,
            },
            {
              key: 'accounts',
              label: `往来账龄（${accounts?.count ?? 0}）`,
              children: (
                <>
                  {aging && (
                    <Descriptions size="small" column={4} style={{ marginBottom: 12 }}>
                      <Descriptions.Item label="0-30 天"><span style={{ color: COLORS.green }}>¥{aging.current}</span></Descriptions.Item>
                      <Descriptions.Item label="31-60 天"><span style={{ color: COLORS.yellow }}>¥{aging.over30}</span></Descriptions.Item>
                      <Descriptions.Item label=">60 天"><span style={{ color: COLORS.orange }}>¥{aging.over60}</span></Descriptions.Item>
                      <Descriptions.Item label="逾期"><span style={{ color: COLORS.red }}>¥{aging.overdue}</span></Descriptions.Item>
                    </Descriptions>
                  )}
                  {accounts?.rows.length ? (
                    <Table<SupplyAccountRow> rowKey={(r) => String(r.id ?? r.supplier)} columns={accCols} dataSource={accounts.rows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                  ) : <Empty description="暂无供应商往来账" />}
                </>
              ),
            },
            {
              key: 'price',
              label: `原料比价（${price?.report.tip.onSale ?? 0}）`,
              children: (
                <>
                  {price && (
                    <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`待比价原料：${price.report.tip.onSale} 种 · 尚无报价 ${price.report.tip.noQuote} 种 · 已有报价 ${price.report.tip.hasQuote} 种`} />
                  )}
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Input.Search placeholder="搜索原料名 / 分类" allowClear style={{ width: 240 }} value={priceQ} onChange={(e) => setPriceQ(e.target.value)} onSearch={setPriceQ} />
                    <Select<PriceFilter> value={priceF} onChange={setPriceF} style={{ width: 150 }} options={[
                      { value: 'all', label: '全部' },
                      { value: 'better', label: '外价更低' },
                      { value: 'worse', label: '外价更高' },
                      { value: 'none', label: '暂无报价' },
                    ]} />
                    <Button onClick={() => setPlanOpen(true)}>待比价清单</Button>
                  </Space>
                  {priceRows.length ? (
                    <Table<PriceReportRow> rowKey="ingId" columns={priceCols} dataSource={priceRows} loading={loading} pagination={{ pageSize: 12 }} size="small" />
                  ) : <Empty description="暂无原料比价数据" />}
                </>
              ),
            },
          ]}
        />

        {(overview?.advice ?? []).length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{overview?.advice.join('；')}</Typography.Paragraph>
        )}
      </Card>

      <Modal title="供应商登记" open={vOpen} onCancel={() => setVOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitVendor}>
        <Form form={vForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="供应商名称" rules={[{ required: true, message: '请填写名称' }]}><Input /></Form.Item>
          <Form.Item name="vendor_id" label="编号"><Input placeholder="选填，留空自动生成" /></Form.Item>
          <Form.Item name="category" label="供应品类" rules={[{ required: true }]}>
            <Select options={['肉类', '蔬菜', '粮油', '调料', '冻品', '其他'].map((s) => ({ value: s, label: s }))} />
          </Form.Item>
          <Form.Item name="period" label="账期"><Input placeholder="月结30天 / 现结" /></Form.Item>
          <Form.Item name="level" label="评级（星）"><InputNumber style={{ width: '100%' }} min={0} max={5} /></Form.Item>
          <Form.Item name="status" label="状态"><Select options={['合作中', '考察中', '暂停'].map((s) => ({ value: s, label: s }))} /></Form.Item>
          <Form.Item name="contact" label="联系人"><Input /></Form.Item>
          <Form.Item name="phone" label="电话"><Input /></Form.Item>
          <Alert type="info" showIcon message="档案入队 vendor.upsert，经审批中心确认才写回。" />
        </Form>
      </Modal>

      <Modal title="录入供应商报价" open={qOpen} onCancel={() => setQOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitQuote}>
        <Form form={qForm} layout="vertical" preserve={false}>
          <Form.Item name="ing" label="原料" rules={[{ required: true, message: '请选择原料' }]}>
            <Select
              showSearch
              placeholder="选择在售原料"
              options={qRows.map((r) => ({ value: r.name, label: `${r.name}（本店均价 ¥${r.avg}/${r.unit}）` }))}
              filterOption={(inp, opt) => String(opt?.label ?? '').includes(inp)}
            />
          </Form.Item>
          <Form.Item name="src" label="供应商" rules={[{ required: true, message: '请填写供应商' }]}><Input /></Form.Item>
          <Form.Item name="per" label="报价口径" initialValue="buy">
            <Select
              options={[
                { value: 'buy', label: qRow && qRow.conv > 1 ? `按采购单位（元/${qRow.buy}，1${qRow.buy}=${qRow.conv}${qRow.unit}）` : '按采购单位' },
                { value: 'stock', label: qRow ? `按库存单位（元/${qRow.unit}）` : '按库存单位' },
              ]}
            />
          </Form.Item>
          <Form.Item name="price" label="报价金额（元）" rules={[{ required: true, message: '请填写报价' }]}><InputNumber style={{ width: '100%' }} min={0} step={0.01} /></Form.Item>
          {qHint && (
            <Alert
              style={{ marginBottom: 12 }}
              showIcon
              type={qHint.diff < -0.01 ? 'success' : qHint.diff > 0.01 ? 'warning' : 'info'}
              message={
                `折算 ¥${qHint.unit.toFixed(2)}/${qHint.unitName}，与本店均价 ¥${qHint.avg} 相比：` +
                (qHint.diff < -0.01
                  ? `低 ¥${(-qHint.diff).toFixed(2)}（省 ${qHint.pct.toFixed(0)}%）`
                  : qHint.diff > 0.01
                    ? `高 ¥${qHint.diff.toFixed(2)}（贵 ${qHint.pct.toFixed(0)}%）`
                    : '基本持平')
              }
            />
          )}
          <Form.Item name="unit" label="单位"><Input placeholder="kg / 箱" /></Form.Item>
          <Form.Item name="note" label="备注"><Input placeholder="含运 / 到店价" /></Form.Item>
          <Form.Item name="set_default_sup" label="设为该原料默认供应商" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>

      <Modal title="采购应付登记" open={poOpen} onCancel={() => setPoOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitPo}>
        <Form form={poForm} layout="vertical" preserve={false}>
          <Form.Item name="vendor_id" label="供应商" rules={[{ required: true, message: '请填写供应商' }]}><Input placeholder="供应商名称或编号" /></Form.Item>
          <Form.Item name="amount" label="应付金额（元）" rules={[{ required: true, message: '请填写金额' }]}><InputNumber style={{ width: '100%' }} min={0.01} /></Form.Item>
          <Form.Item name="ref_no" label="关联单号"><Input placeholder="选填" /></Form.Item>
          <Form.Item name="ts" label="日期"><DatePicker style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      <Modal title="供应链配置" open={cfgOpen} onCancel={() => setCfgOpen(false)} confirmLoading={busy} destroyOnHidden onOk={submitCfg}>
        <Form form={cfgForm} layout="vertical" preserve={false}>
          <Form.Item name="spread_warn_pct" label="价差告警阈值（%）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} /></Form.Item>
          <Form.Item name="aging_over30_d" label="账龄 30 天档" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={1} /></Form.Item>
          <Form.Item name="aging_over60_d" label="账龄 60 天档" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={1} /></Form.Item>
          <Form.Item name="low_level" label="低评级线（星）" rules={[{ required: true }]}><InputNumber style={{ width: '100%' }} min={0} max={5} /></Form.Item>
          <Alert type="info" showIcon message="需满足：30 天档 < 60 天档；保存即对全店供应链台账生效。" />
        </Form>
      </Modal>

      <Modal title={`待比价清单（${price?.plan.onSale ?? 0}）`} open={planOpen} footer={null} onCancel={() => setPlanOpen(false)} width={820}>
        {price?.plan.items.length ? (
          <Table<PricePlanItem> rowKey="ingId" columns={planCols} dataSource={price.plan.items} pagination={{ pageSize: 12 }} size="small" />
        ) : <Empty description="暂无在售原料" />}
      </Modal>
    </div>
  )
}
