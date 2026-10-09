import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  List,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { fetchFoodsafeTrace } from '../../api'
import type { TraceResp, TraceRow } from '../../api/types'
import { COLORS } from '../../theme'

function checkTag(r: TraceRow) {
  if (r.missing_cert) return <Tag color={COLORS.yellow}>待补报告</Tag>
  const v = String(r.check_result ?? '-')
  const color = /合格|pass/i.test(v)
    ? COLORS.green
    : /待|warn/i.test(v)
      ? COLORS.yellow
      : COLORS.red
  return <Tag color={color}>{v}</Tag>
}

/** 下钻记录（进货/销售为异构行，best-effort 展示） */
function RecordList({ data, empty }: { data: Record<string, unknown>[]; empty: string }) {
  if (data.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />
  return (
    <List
      size="small"
      bordered
      dataSource={data}
      renderItem={(row) => (
        <List.Item>
          <Space wrap>
            {Object.entries(row)
              .slice(0, 8)
              .map(([k, v]) => (
                <span key={k}>
                  <Typography.Text type="secondary">{k}:</Typography.Text> {String(v ?? '-')}
                </span>
              ))}
          </Space>
        </List.Item>
      )}
    />
  )
}

export default function TracePage() {
  const [data, setData] = useState<TraceResp | null>(null)
  const [isMock, setIsMock] = useState(false)
  const [loading, setLoading] = useState(true)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drill, setDrill] = useState<TraceResp | null>(null)
  const [drillOpen, setDrillOpen] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    fetchFoodsafeTrace()
      .then((r) => {
        setData(r)
        setIsMock(false)
      })
      .catch(() => {
        setData(null)
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openDrill = (batch: string) => {
    setDrillOpen(true)
    setDrillLoading(true)
    setDrill(null)
    fetchFoodsafeTrace({ batch })
      .then((r) => setDrill(r))
      .catch(() => setDrill(null))
      .finally(() => setDrillLoading(false))
  }

  const cols: ColumnsType<TraceRow> = [
    {
      title: '批次',
      dataIndex: 'batch_no',
      width: 160,
      render: (v) => <span style={{ fontWeight: 600 }}>{v}</span>,
    },
    { title: '原料', dataIndex: 'ing_name' },
    { title: '供应商', dataIndex: 'supplier', width: 160 },
    {
      title: '到货日',
      dataIndex: 'recv_date',
      width: 120,
      render: (v) => v ?? <span style={{ color: COLORS.gray }}>-</span>,
    },
    {
      title: '产地',
      dataIndex: 'origin',
      width: 120,
      render: (v) => v ?? <span style={{ color: COLORS.gray }}>-</span>,
    },
    { title: '检验结果', key: 'check', width: 130, render: (_, r) => checkTag(r) },
    {
      title: '操作',
      key: 'op',
      width: 100,
      render: (_, r) => (
        <Button size="small" onClick={() => openDrill(r.batch_no)}>
          下钻
        </Button>
      ),
    },
  ]

  const batch = drill?.batch ?? null

  return (
    <div>
      {isMock && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端 /api/foodsafe/trace 未连通，当前为本地样例数据"
        />
      )}

      {(data?.missing_cert ?? 0) > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`溯源批次待补检验报告 ${data?.missing_cert} 个`}
        />
      )}

      <Card
        title={`溯源批次（${data?.batches ?? 0} 个批次）`}
        extra={
          <Button size="small" onClick={load}>
            刷新
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          溯源批次由供应商入库同步，后台只读展示；点击「下钻」按批号/原料名 best-effort 关联进货与销售记录。
        </Typography.Paragraph>
        <Table<TraceRow>
          rowKey={(r) => String(r.id ?? r.batch_no)}
          columns={cols}
          dataSource={data?.rows ?? []}
          loading={loading}
          pagination={{ pageSize: 20 }}
          size="small"
        />
      </Card>

      <Drawer
        title={`批次下钻 · ${batch?.batch_no ?? drill?.query ?? '-'}`}
        width={640}
        open={drillOpen}
        onClose={() => setDrillOpen(false)}
        loading={drillLoading}
      >
        {batch ? (
          <>
            {batch.missing_cert && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="该批次缺检验报告/合格证，请向供应商补充"
              />
            )}
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="批次">{batch.batch_no}</Descriptions.Item>
              <Descriptions.Item label="原料">{batch.ing_name}</Descriptions.Item>
              <Descriptions.Item label="供应商">{batch.supplier}</Descriptions.Item>
              <Descriptions.Item label="到货日">{batch.recv_date ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="产地">{batch.origin ?? '-'}</Descriptions.Item>
              <Descriptions.Item label="合格证">
                {batch.cert_no ?? <Tag color={COLORS.yellow}>缺</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="检验结果">{checkTag(batch)}</Descriptions.Item>
            </Descriptions>

            <Card size="small" title="关联进货记录" style={{ marginBottom: 12 }}>
              <RecordList data={drill?.drill?.recv ?? []} empty="未关联到进货记录" />
            </Card>
            <Card size="small" title="关联销售记录">
              <RecordList data={drill?.drill?.sales ?? []} empty="未关联到销售记录" />
              {drill?.drill?.note && (
                <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                  {drill.drill.note}
                </Typography.Paragraph>
              )}
            </Card>
          </>
        ) : (
          !drillLoading && <Empty description="未匹配到批次" />
        )}
      </Drawer>
    </div>
  )
}
