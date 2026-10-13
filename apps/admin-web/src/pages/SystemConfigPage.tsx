import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Table,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { client } from '../api/client'
import {
  createSnapshotBackup,
  fetchExportBackupBlob,
  fetchExportCsvBlob,
  fetchSettleTemplate,
  fetchSnapshot,
  fetchSnapshotBackups,
  postAction,
  saveSettleTemplate,
} from '../api'
import type { SnapshotBackupItem } from '../api'
import type { SettleTemplate } from '../api/types'
import { DEFAULT_SETTLE_TPL, normalizeSettleTpl } from './inventory/settle/template'
import { downloadBlob } from './inventory/settle/download'
import { DEF_COMPARE_PLATFORMS, normalizeComparePlatforms } from './inventory/comparePlatforms'
import type { ComparePlatform } from './inventory/comparePlatforms'
import { useAuthStore } from '../store/auth'

/** 今日（本地）日期串，用于导出文件名 */
function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** FP-SET-07 备份体积展示（KB / MB） */
function fmtSize(n: number): string {
  if (!n) return '-'
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`
}

/** FP-SET-07 备份时间展示（ISO → YYYY-MM-DD HH:mm:ss 本地近似） */
function fmtBackupTime(iso: string | null): string {
  return iso ? iso.replace('T', ' ').slice(0, 19) : '-'
}

/** FP-SET-01 通道一览行 */
type ChannelRow = { key: string; module: string; source: string; input: string; status: string }

type Config = {
  safety_stock?: Record<string, number>
  uniform_sop?: string
  plate_sop?: string
  note?: string
  [k: string]: unknown
}

export default function SystemConfigPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限（配置写仅老板/店长）'
  const [config, setConfig] = useState<Config>({})
  const [source, setSource] = useState<string>('-')
  const [rev, setRev] = useState<string | number | undefined>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm()

  /* FP-SET-03/04 + FP-PRICE-10：外接比价平台（名称 + `{kw}` 搜索 URL 模板），存 `config.compare_platforms` */
  const [platforms, setPlatforms] = useState<ComparePlatform[]>(DEF_COMPARE_PLATFORMS.map((p) => ({ ...p })))
  const [platBusy, setPlatBusy] = useState(false)

  /* FP-SET-02：餐厅名称（顶层 data.rest，rest.update 动作） */
  const [restName, setRestName] = useState('')
  const [restBusy, setRestBusy] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    client
      .get<{ ok: boolean; config: Config; source?: string; rev?: number; rest?: string }>('/admin/config')
      .then(({ data }) => {
        const c = data.config || {}
        setConfig(c)
        setSource(data.source || '-')
        setRev(data.rev)
        setRestName(data.rest || '熊猫五福餐厅')
        form.setFieldsValue({
          uniform_sop: c.uniform_sop ?? '',
          plate_sop: c.plate_sop ?? '',
          note: c.note ?? '',
          flour_safe: (c.safety_stock as Record<string, number> | undefined)?.['面粉'] ?? 10,
        })
        setPlatforms(normalizeComparePlatforms(c.compare_platforms))
      })
      .catch((e) => message.error(e?.response?.data?.error || '加载配置失败'))
      .finally(() => setLoading(false))
  }, [form])

  useEffect(() => {
    load()
  }, [load])

  /* ---- FP-SET-03/04 + FP-PRICE-10：比价平台增删改（旧版 renderSet/platTable，HTML:5230-5283）---- */
  const updatePlatform = (i: number, patch: Partial<ComparePlatform>) =>
    setPlatforms((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  const removePlatform = (i: number) => setPlatforms((prev) => prev.filter((_, idx) => idx !== i))
  const addPlatform = () =>
    setPlatforms((prev) => [...prev, { name: '新平台', tpl: 'https://www.baidu.com/s?wd={kw}' }])

  const savePlatforms = async () => {
    setPlatBusy(true)
    try {
      await client.post('/admin/config', { config: { compare_platforms: platforms } })
      message.success('比价平台已入队 → 请到审批中心确认执行')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败（仅老板/店长可改）')
    } finally {
      setPlatBusy(false)
    }
  }

  /* ---- FP-SET-02：保存餐厅名（写顶层 data.rest，rest.update 动作）---- */
  const saveRestName = async () => {
    const name = restName.trim()
    if (!name) {
      message.error('餐厅名称不能为空')
      return
    }
    setRestBusy(true)
    try {
      await client.post('/admin/rest', { name })
      message.success('餐厅名已入队 → 请到审批中心确认执行')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败（仅老板/店长可改）')
    } finally {
      setRestBusy(false)
    }
  }

  /* ---- 结算单模板（FP-SET-18/19，与 FP-RECV-06 同一缺口）----
   * 存储位置：bff/data/settle_template.json（独立文件）。
   * 不进业务库、不走审批队列 —— 它只是「只读输出层」的排版配置，不是业务数据。
   */
  const [tpl, setTpl] = useState<SettleTemplate>(DEFAULT_SETTLE_TPL)
  const [tplSource, setTplSource] = useState<string>('-')
  const [tplBusy, setTplBusy] = useState(false)
  const [tplForm] = Form.useForm()

  const fillTplForm = useCallback((t: SettleTemplate) => {
    tplForm.setFieldsValue({ ...t, subjects: (t.subjects || []).join('/') })
  }, [tplForm])

  const loadTpl = useCallback(() => {
    fetchSettleTemplate()
      .then((r) => {
        const t = normalizeSettleTpl(r.template)
        setTpl(t)
        setTplSource(r.source || '-')
        fillTplForm(t)
      })
      .catch((e: unknown) => {
        const err = e as { response?: { data?: { error?: string } } }
        message.error(err.response?.data?.error || '加载结算单模板失败')
      })
  }, [fillTplForm])

  useEffect(() => {
    loadTpl()
  }, [loadTpl])

  const saveTpl = async (vals: Record<string, string>) => {
    setTplBusy(true)
    try {
      const subs = String(vals.subjects || '')
        .split(/[、,，/]/)
        .map((s) => s.trim())
        .filter(Boolean)
      const next = normalizeSettleTpl({ ...tpl, ...vals, subjects: subs })
      const r = await saveSettleTemplate(next)
      const t = normalizeSettleTpl(r.template)
      setTpl(t)
      setTplSource('file')
      fillTplForm(t)
      message.success('结算单模板已保存（独立文件，不影响业务数据）')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '保存失败（仅老板/店长可改）')
    } finally {
      setTplBusy(false)
    }
  }

  const resetTpl = async () => {
    setTplBusy(true)
    try {
      const r = await saveSettleTemplate(DEFAULT_SETTLE_TPL)
      const t = normalizeSettleTpl(r.template)
      setTpl(t)
      setTplSource('default')
      fillTplForm(t)
      message.success('已恢复默认模板（不影响采购单/库存等业务数据）')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '恢复默认失败')
    } finally {
      setTplBusy(false)
    }
  }

  /* ---- FP-SET-11/12/13/14 数据导出（只读：只产出文件，不发任何写请求）----
   * 对应旧版设置页「数据备份」组（#btnExport/#btnCsvIng/#btnCsvDish/#btnCsvSale，HTML:609-612）。
   * 走 BFF 只读端点 /api/export/*（blob），前端只负责命名与落盘。
   */
  const [exporting, setExporting] = useState<string | null>(null)

  const doExport = async (kind: 'backup' | 'ings' | 'dishes' | 'sales') => {
    setExporting(kind)
    try {
      const blob = kind === 'backup' ? await fetchExportBackupBlob() : await fetchExportCsvBlob(kind)
      const names: Record<string, string> = {
        backup: `熊猫五福进销存备份_${todayStr()}.json`,
        ings: `原料库存_${todayStr()}.csv`,
        dishes: `菜品成本毛利_${todayStr()}.csv`,
        sales: `销售应收实收_${todayStr()}.csv`,
      }
      const filename = names[kind]
      downloadBlob(filename, blob)
      message.success(`已导出 ${filename}`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } }; message?: string }
      message.error(err?.response?.data?.error || err?.message || '导出失败')
    } finally {
      setExporting(null)
    }
  }

  /* ---- FP-SET-01 各模块数据输入通道一览（只读，复用快照数据）---- */
  const [snap, setSnap] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    fetchSnapshot()
      .then((s) => setSnap(s as unknown as Record<string, unknown>))
      .catch(() => setSnap(null))
  }, [])

  /* ---- FP-SET-07 服务端快照备份（手动打快照 + 备份列表；形态见 ADR-009 §2.1）----
   * 只写服务端 data/snapshots/ 的备份文件：**不写业务库、不入审批队列**。
   * 回滚（FP-SET-10 的另一半）属高危写，须经运营管理员审批走队列，本页暂不提供入口。
   */
  const [backups, setBackups] = useState<SnapshotBackupItem[]>([])
  const [backupsLoading, setBackupsLoading] = useState(false)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupNote, setBackupNote] = useState('')
  const [backupKeep, setBackupKeep] = useState(0)

  const loadBackups = useCallback(() => {
    setBackupsLoading(true)
    fetchSnapshotBackups()
      .then((r) => {
        setBackups(r.items || [])
        setBackupKeep(r.keep || 0)
      })
      .catch(() => {
        setBackups([])
        setBackupKeep(0)
      })
      .finally(() => setBackupsLoading(false))
  }, [])

  useEffect(() => {
    loadBackups()
  }, [loadBackups])

  const doBackup = async () => {
    setBackupBusy(true)
    try {
      const r = await createSnapshotBackup(backupNote.trim())
      message.success(
        `已打快照备份 ${r.item.id}（rev ${r.item.rev ?? '-'}）` +
          (r.dropped ? `，已淘汰最旧 ${r.dropped} 份` : ''),
      )
      setBackupNote('')
      loadBackups()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '打快照失败（仅老板/店长可操作）')
    } finally {
      setBackupBusy(false)
    }
  }

  return (
    <div>
    <Card
      title="系统配置"
      loading={loading}
      extra={
        <Space>
          <Typography.Text type="secondary">
            来源 {source} · rev {rev ?? '-'}
          </Typography.Text>
          <Button size="small" onClick={load}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="配置变更经审批中心入队（config.update），由店内消费器执行后生效，不会直写店内库。"
      />
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 560 }}
        onFinish={async (vals) => {
          setBusy(true)
          try {
            const payload = {
              uniform_sop: vals.uniform_sop,
              plate_sop: vals.plate_sop,
              note: vals.note,
              safety_stock: {
                ...(typeof config.safety_stock === 'object' ? config.safety_stock : {}),
                面粉: vals.flour_safe,
              },
            }
            try {
              /* 优先走 /api/admin/config（服务端 RBAC 更严：仅老板/店长） */
              await client.post('/admin/config', { config: payload })
              message.success('已入队 → 请到审批中心确认执行')
            } catch {
              /* 端点不可用或被拒时回退原 actions 链路 */
              await postAction({
                type: 'config.update',
                payload,
                operator: 'admin',
              })
              message.success('已入队（actions 链路）→ 请到审批中心确认执行')
            }
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } } }
            message.error(err.response?.data?.error || '提交失败')
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form.Item name="uniform_sop" label="工服 SOP">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="plate_sop" label="装盘 SOP">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Form.Item name="flour_safe" label="面粉安全库存(kg)">
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input />
        </Form.Item>
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button type="primary" htmlType="submit" loading={busy} disabled={!canWrite}>
            提交配置变更
          </Button>
        </Tooltip>
      </Form>
    </Card>

    <Card title="餐厅名称" style={{ marginTop: 16 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="餐厅名存于快照顶层 data.rest（rest.update 动作），用作抬头与结算单回落名；变更经审批中心入队，由店内消费器执行后生效。"
      />
      <Space>
        <Input
          value={restName}
          disabled={!canWrite}
          onChange={(e) => setRestName(e.target.value)}
          style={{ width: 320 }}
          placeholder="如：熊猫五福餐厅"
        />
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button type="primary" loading={restBusy} disabled={!canWrite} onClick={saveRestName}>
            保存餐厅名称
          </Button>
        </Tooltip>
      </Space>
    </Card>

    <Card
      title="外接比价平台"
      style={{ marginTop: 16 }}
      extra={<Typography.Text type="secondary">共 {platforms.length} 个</Typography.Text>}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="「去比价」跳转的搜索平台（名称 + 搜索 URL 模板，{kw} 代关键词）。变更经审批中心入队（config.update），不影响业务库。"
      />
      <Table<ComparePlatform & { key: string }>
        rowKey="key"
        size="small"
        pagination={false}
        dataSource={platforms.map((p, i) => ({ ...p, key: String(i) }))}
        columns={[
          {
            title: '平台名称',
            dataIndex: 'name',
            width: 200,
            render: (v: string, _r, i) => (
              <Input value={v} disabled={!canWrite} onChange={(e) => updatePlatform(i, { name: e.target.value })} />
            ),
          },
          {
            title: '搜索URL（{kw}=关键词）',
            dataIndex: 'tpl',
            render: (v: string, _r, i) => (
              <Input value={v} disabled={!canWrite} onChange={(e) => updatePlatform(i, { tpl: e.target.value })} />
            ),
          },
          {
            title: '',
            width: 70,
            render: (_v, _r, i) => (
              <Button size="small" danger disabled={!canWrite} onClick={() => removePlatform(i)}>
                删
              </Button>
            ),
          },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <Button disabled={!canWrite} onClick={addPlatform}>
          新增平台
        </Button>
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button type="primary" loading={platBusy} disabled={!canWrite} onClick={savePlatforms}>
            保存平台配置
          </Button>
        </Tooltip>
      </Space>
    </Card>

    <Card
      title="结算单模板"
      style={{ marginTop: 16 }}
      extra={
        <Space>
          <Typography.Text type="secondary">来源 {tplSource}</Typography.Text>
          <Button size="small" onClick={loadTpl}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="结算单是只读输出层。模板存于服务端独立文件（bff/data/settle_template.json），不进业务库、不走审批队列；保存即刻生效，恢复默认也不会动采购单/库存等业务数据。"
      />
      <Form form={tplForm} layout="vertical" style={{ maxWidth: 560 }} onFinish={saveTpl}>
        <Form.Item name="title" label="单据标题">
          <Input placeholder="进货付款审批单" />
        </Form.Item>
        <Form.Item name="restName" label="抬头单位名称">
          <Input placeholder="留空则回落餐厅名" />
        </Form.Item>
        <Form.Item name="addr" label="地址">
          <Input />
        </Form.Item>
        <Form.Item name="tel" label="电话">
          <Input />
        </Form.Item>
        <Form.Item name="taxNo" label="税号">
          <Input />
        </Form.Item>
        <Form.Item name="usePurpose" label="支出用途（默认）">
          <Input placeholder="采购货款" />
        </Form.Item>
        <Form.Item name="payeeName" label="收款单位">
          <Input />
        </Form.Item>
        <Form.Item name="payeeBank" label="开户行">
          <Input />
        </Form.Item>
        <Form.Item name="payeeAccount" label="银行账号">
          <Input />
        </Form.Item>
        <Form.Item
          name="subjects"
          label="签字栏"
          tooltip="用 / 、 , ，任一分隔，如 经办人/审核人/审批人"
        >
          <Input placeholder="经办人/审核人/审批人" />
        </Form.Item>
        <Form.Item name="footer" label="页脚">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Space>
          <Tooltip title={canWrite ? undefined : noWriteTip}>
            <Button type="primary" htmlType="submit" loading={tplBusy} disabled={!canWrite}>
              保存模板
            </Button>
          </Tooltip>
          <Popconfirm
            title="恢复默认结算单模板？（不影响采购单/库存等业务数据）"
            onConfirm={resetTpl}
            okText="恢复"
            cancelText="取消"
          >
            <Button disabled={!canWrite} loading={tplBusy}>
              恢复默认
            </Button>
          </Popconfirm>
        </Space>
      </Form>
    </Card>

    <Card title="数据导出" style={{ marginTop: 16 }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="导出为只读输出：只生成文件到本地下载，不写业务库、不入审批队列。"
        description="销售应收实收：当前快照 sales[] 仅含 amount（一次性全额收款），故折扣/欠款暂为空、应收=实收=售价合计；待销售应收模型（FP-SALE-07/11）落地后自动按真实口径导出。"
      />
      <Space wrap>
        <Button loading={exporting === 'backup'} onClick={() => doExport('backup')}>
          导出全部数据(JSON)
        </Button>
        <Button loading={exporting === 'ings'} onClick={() => doExport('ings')}>
          导出原料CSV
        </Button>
        <Button loading={exporting === 'dishes'} onClick={() => doExport('dishes')}>
          导出菜品成本CSV
        </Button>
        <Button loading={exporting === 'sales'} onClick={() => doExport('sales')}>
          导出销售CSV
        </Button>
      </Space>
    </Card>

    <Card
      title="快照备份"
      style={{ marginTop: 16 }}
      extra={
        <Space>
          <Typography.Text type="secondary">
            共 {backups.length} 份{backupKeep ? ` · 最多保留 ${backupKeep} 份` : ''}
          </Typography.Text>
          <Button size="small" loading={backupsLoading} onClick={loadBackups}>
            刷新
          </Button>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="服务端快照备份（ADR-009）：把当前快照手动存为一份历史备份（bff/data/snapshots/），只写备份文件，不写业务库、不入审批队列。回滚属高危写，须经运营管理员审批走审批中心，尚未开放入口。"
      />
      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          value={backupNote}
          disabled={!canWrite}
          onChange={(e) => setBackupNote(e.target.value)}
          style={{ width: 240 }}
          placeholder="备份说明（可选）"
        />
        <Tooltip title={canWrite ? undefined : noWriteTip}>
          <Button type="primary" loading={backupBusy} disabled={!canWrite} onClick={doBackup}>
            立即打快照备份
          </Button>
        </Tooltip>
      </Space>
      <Table<SnapshotBackupItem>
        rowKey="id"
        size="small"
        loading={backupsLoading}
        pagination={false}
        locale={{ emptyText: '暂无快照备份' }}
        dataSource={backups}
        columns={BACKUP_COLUMNS}
      />
    </Card>

    <Card
      title="各模块数据输入通道一览"
      style={{ marginTop: 16 }}
      extra={
        <Typography.Text type="secondary">
          {snap ? `快照 rev ${String(snap.rev ?? '-')}` : '未接通快照'}
        </Typography.Text>
      }
    >
      <Table<ChannelRow>
        rowKey="key"
        size="small"
        pagination={false}
        columns={CHANNEL_COLUMNS}
        dataSource={buildChannelRows(snap)}
      />
    </Card>
    </div>
  )
}

const CHANNEL_COLUMNS: ColumnsType<ChannelRow> = [
  { title: '模块', dataIndex: 'module', width: 100, render: (v: string) => <b>{v}</b> },
  { title: '数据来源', dataIndex: 'source', width: 200 },
  { title: '输入方式', dataIndex: 'input' },
  { title: '当前状态', dataIndex: 'status', width: 240 },
]

/** FP-SET-07 快照备份列表列（只读展示；回滚入口待 FP-SET-10 走审批队列后开放） */
const BACKUP_COLUMNS: ColumnsType<SnapshotBackupItem> = [
  { title: '备份时间', dataIndex: 'created_at', width: 180, render: (v: string) => fmtBackupTime(v) },
  {
    title: '快照 rev',
    dataIndex: 'rev',
    width: 100,
    render: (v: number | null) => (v == null ? '-' : String(v)),
  },
  { title: '大小', dataIndex: 'size', width: 100, render: (v: number) => fmtSize(v) },
  { title: '操作人', dataIndex: 'operator', width: 120, render: (v: string | null) => v || '-' },
  { title: '说明', dataIndex: 'note', render: (v: string) => v || '-' },
]

/**
 * FP-SET-01 各模块数据输入通道一览（旧版设置页 HTML:571-585 的 10 行表格）。
 * 口径：模块/数据来源/输入方式照抄旧版并按新版真实入口校正；「当前状态」由当前快照实时推导，
 * 未接通快照时统一显示「未接通快照」，不编造数字。
 */
function buildChannelRows(snap: Record<string, unknown> | null): ChannelRow[] {
  const data = ((snap && (snap.data as Record<string, unknown>)) || {}) as Record<string, unknown>
  const ext = ((snap && (snap.ext as Record<string, unknown>)) || {}) as Record<string, unknown>
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0)
  const st = (s: string) => (snap ? s : '未接通快照')
  return [
    { key: 'ing', module: '原料库存', source: '进货单入库自动生成', input: '新增原料 / 进货单确认 / 导入自动建料', status: st(`${n(data.ings)} 种原料`) },
    { key: 'po', module: '采购管理', source: '手工录入（向供应商下单）', input: '新建采购单（不入库、不影响库存与均价）', status: st(`${n(data.orders)} 张采购单`) },
    { key: 'recv', module: '进货入库', source: '采购单 / 批量导入', input: '新建进货单 / 进货单导入（xlsx·网页表格·CSV·JSON）', status: st(`${n(data.recv)} 张进货单`) },
    { key: 'dish', module: '菜品配方', source: '菜品主数据 + 食谱卡', input: '编辑配方 / 批量导入食谱卡', status: st(`${n(data.dishes)} 道菜品 · ${n(ext.recipes)} 份配方`) },
    { key: 'calc', module: '结构测算', source: '菜品主数据（只读）', input: '调参数 / 调价调量（仅模拟）', status: '只读测算层 · 结果不写回配方与库存' },
    { key: 'sale', module: '销售收银', source: '移动端收银（平台导入待建）', input: '新建销售单（每单录入）', status: st(`${n(data.sales)} 条销售流水`) },
    { key: 'price', module: '外接比价', source: '手工录入 / 脚本抓价', input: '去比价→录入报价 / 生成任务→跑脚本→导入结果', status: st(`${n(data.quotes)} 条报价`) },
    { key: 'log', module: '库存流水', source: '期初+采购+销售+盘点自动重放', input: '盘点调整（手工）', status: st(`${n(data.logs)} 条流水`) },
    { key: 'settle', module: '结算单', source: '进货入库（只读单条进货单）', input: '无需录入 · 在进货单行点「结算单」生成', status: st(`进货单 ${n(data.recv)} 张可生成`) },
    { key: 'dash', module: '经营概览', source: '各模块自动汇总', input: '无需单独录入', status: st(`快照 rev ${String(snap && snap.rev != null ? snap.rev : '-')}`) },
  ]
}
