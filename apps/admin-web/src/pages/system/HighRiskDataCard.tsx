/*
 * HighRiskDataCard.tsx — W4 高危三件套的设置页入口（ADR-013 D4 / FP-SET-15/16/17）。
 *
 *   ① 导入 JSON 备份恢复（W4-01）：上传 → 只读预览（差异统计）→ 输入「确认恢复」→ 入队；
 *   ② 重置为真实数据基线（W4-02）：选基线版本 → 预览「将丢弃 N 条 / 将恢复 N 条」→ 输入「确认重置」→ 入队；
 *   ③ 清空全部业务数据（W4-03）：两档（只清业务 / 回到首次安装）→ 预览 → 输入「确认清空」→ 入队。
 *
 * 红线（与 ADR-013 §6 对齐）：
 *   · 本组件**不发任何直接写库请求**：预览只读，写全部入 /api/actions 队列，由执行器在审批确认后落库；
 *   · 三项仅老板/店长：前端 disabled 只是体验层，真正的门禁在 BFF（HIGH_RISK_TYPES）；
 *   · 执行器会在执行前自动打一份新备份（备份失败即拒绝执行），前端只做告知，不做承诺。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd'
import {
  fetchBaselinePreview,
  fetchBaselines,
  fetchClearPreview,
  previewSnapshotImport,
  submitResetBaseline,
  submitSnapshotClear,
  submitSnapshotImport,
} from '../../api/snapshotHighRisk'
import type {
  BaselineItem,
  BaselinePreview,
  ClearPreview,
  SnapshotImportPreview,
  SnapshotSummary,
} from '../../api/snapshotHighRisk'
import { useAuthStore } from '../../store/auth'

const WORD_IMPORT = '确认恢复'
const WORD_BASELINE = '确认重置'
const WORD_CLEAR = '确认清空'

function errText(e: unknown, fallback: string): string {
  const err = e as { response?: { data?: { error?: string } }; message?: string }
  return err.response?.data?.error || err.message || fallback
}

/** 规模摘要一行文案（口径与后端 countSummary 一致） */
function SummaryLine({ s }: { s: SnapshotSummary }) {
  return (
    <span>
      原料 {s.ings} 种 · 进货单 {s.recv} 张 · 销售 {s.sales} 条 · 报价 {s.quotes} 条 · 库存流水{' '}
      {s.logs} 条 · 菜品 {s.dishes} 道 · 扩展表 {s.ext_tables} 张
    </span>
  )
}

/** 确认词弹窗：高危写的统一收口（Popconfirm 之上再加一道手输确认词，ADR-013 D4-1） */
function ConfirmWordModal(props: {
  open: boolean
  title: string
  word: string
  summary: React.ReactNode
  busy: boolean
  onCancel: () => void
  onOk: () => void
}) {
  const { open, title, word, summary, busy, onCancel, onOk } = props
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (open) setTyped('')
  }, [open])
  return (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      confirmLoading={busy}
      okText={`确认执行（输入「${word}」）`}
      okButtonProps={{ danger: true, disabled: typed.trim() !== word }}
      onOk={onOk}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Alert
          type="error"
          showIcon
          message="这是覆盖式高危写：会整包替换 data + ext，当前业务数据将被丢弃（不可撤销）。"
          description="执行器会在执行前自动打一份快照备份；备份失败将拒绝执行。"
        />
        {summary}
        <Input
          placeholder={`请输入确认词：${word}`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </Space>
    </Modal>
  )
}

export default function HighRiskDataCard() {
  const role = useAuthStore((s) => s.role)
  const isBoss = role === '老板' || role === '店长'
  const tip = '高危操作仅老板/店长可执行'

  /* ---------------- W4-01 导入备份恢复 ---------------- */
  const [importName, setImportName] = useState('')
  const [importSnap, setImportSnap] = useState<unknown>(null)
  const [importPreview, setImportPreview] = useState<SnapshotImportPreview | null>(null)
  const [importReason, setImportReason] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const onImportFile = async (file: File) => {
    setImportBusy(true)
    setImportPreview(null)
    setImportSnap(null)
    setImportName(file.name)
    try {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        message.error('文件不是合法 JSON（请选「导出全部数据」或快照备份的 .json）')
        return
      }
      const p = await previewSnapshotImport(parsed)
      setImportSnap(parsed)
      setImportPreview(p)
    } catch (e) {
      message.error(errText(e, '导入预览失败'))
    } finally {
      setImportBusy(false)
    }
  }

  const doImport = async () => {
    setImportBusy(true)
    try {
      const r = await submitSnapshotImport(importSnap, importReason.trim())
      message.success(
        `导入恢复已入队（${r.import_id}）→ 请到审批中心确认执行（执行前会自动打新备份）`,
      )
      setImportOpen(false)
      setImportPreview(null)
      setImportSnap(null)
      setImportName('')
      setImportReason('')
    } catch (e) {
      message.error(errText(e, '导入入队失败（仅老板/店长可操作）'))
    } finally {
      setImportBusy(false)
    }
  }

  /* ---------------- W4-02 重置为真实数据基线 ---------------- */
  const [baselines, setBaselines] = useState<BaselineItem[]>([])
  const [baseVer, setBaseVer] = useState<string | undefined>()
  const [basePreview, setBasePreview] = useState<BaselinePreview | null>(null)
  const [baseReason, setBaseReason] = useState('')
  const [baseBusy, setBaseBusy] = useState(false)
  const [baseOpen, setBaseOpen] = useState(false)

  const loadBaselines = useCallback(async () => {
    try {
      const r = await fetchBaselines()
      setBaselines(r.items)
      if (r.items.length) setBaseVer((cur) => cur || r.items[0].version)
    } catch {
      setBaselines([])
    }
  }, [])

  useEffect(() => {
    void loadBaselines()
  }, [loadBaselines])

  useEffect(() => {
    if (!baseVer) return
    let alive = true
    fetchBaselinePreview(baseVer)
      .then((p) => {
        if (alive) setBasePreview(p)
      })
      .catch((e) => {
        if (alive) {
          setBasePreview(null)
          message.error(errText(e, '基线预览失败'))
        }
      })
    return () => {
      alive = false
    }
  }, [baseVer])

  const doResetBaseline = async () => {
    if (!baseVer) return
    setBaseBusy(true)
    try {
      await submitResetBaseline({ baseline_version: baseVer, reason: baseReason.trim() })
      message.success('重置基线已入队 → 请到审批中心确认执行（执行前会自动打新备份）')
      setBaseOpen(false)
      setBaseReason('')
    } catch (e) {
      message.error(errText(e, '重置基线入队失败（仅老板/店长可操作）'))
    } finally {
      setBaseBusy(false)
    }
  }

  /* ---------------- W4-03 清空业务数据 ---------------- */
  const [scope, setScope] = useState<'business' | 'all'>('business')
  const [clearPreview, setClearPreview] = useState<ClearPreview | null>(null)
  const [clearReason, setClearReason] = useState('')
  const [clearBusy, setClearBusy] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)

  useEffect(() => {
    let alive = true
    fetchClearPreview(scope)
      .then((p) => {
        if (alive) setClearPreview(p)
      })
      .catch(() => {
        if (alive) setClearPreview(null)
      })
    return () => {
      alive = false
    }
  }, [scope])

  const doClear = async () => {
    setClearBusy(true)
    try {
      await submitSnapshotClear({ scope, reason: clearReason.trim() })
      message.success('清空已入队 → 请到审批中心确认执行（执行前会自动打新备份）')
      setClearOpen(false)
      setClearReason('')
    } catch (e) {
      message.error(errText(e, '清空入队失败（仅老板/店长可操作）'))
    } finally {
      setClearBusy(false)
    }
  }

  /* ---------------- 渲染 ---------------- */
  const importSummary = importPreview ? (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <div>
        导入文件 rev <b>{importPreview.incoming_rev ?? '-'}</b> · 当前快照 rev{' '}
        <b>{importPreview.current_rev ?? '-'}</b>
        {importPreview.schema_steps ? (
          <Tag color="gold" style={{ marginLeft: 8 }}>
            需迁移 {importPreview.schema_steps} 步
          </Tag>
        ) : (
          <Tag color="green" style={{ marginLeft: 8 }}>
            schema 校验通过
          </Tag>
        )}
      </div>
      <div>
        <b>将丢弃当前</b>：<SummaryLine s={importPreview.will_discard} />
      </div>
      <div>
        <b>恢复后将包含</b>：<SummaryLine s={importPreview.will_restore} />
      </div>
    </Space>
  ) : null

  const baselineSummary = basePreview ? (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <div>
        基线 <b>{basePreview.baseline_version}</b>
        {basePreview.baseline_generated_at ? `（生成 ${basePreview.baseline_generated_at.slice(0, 19)}）` : ''} ·
        当前快照 rev <b>{basePreview.current_rev ?? '-'}</b>
        <Tag color={basePreview.checksum_ok ? 'green' : 'red'} style={{ marginLeft: 8 }}>
          {basePreview.checksum_ok ? '校验和通过' : '校验和不匹配'}
        </Tag>
      </div>
      <div>
        <b>将丢弃当前</b>：<SummaryLine s={basePreview.will_discard} />
      </div>
      <div>
        <b>重置后将包含</b>：<SummaryLine s={basePreview.will_restore} />
      </div>
    </Space>
  ) : null

  const clearSummary = clearPreview ? (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <div>
        当前快照 rev <b>{clearPreview.current_rev ?? '-'}</b> · 保留主数据键：
        <Typography.Text code>{clearPreview.kept_data.join(' / ') || '（无）'}</Typography.Text>
      </div>
      <div>
        <b>将丢弃</b>：<SummaryLine s={clearPreview.will_discard} />
      </div>
      <div>
        <b>清空后剩余</b>：<SummaryLine s={clearPreview.remaining} />
      </div>
      {scope === 'all' ? (
        <Alert
          type="error"
          showIcon
          message="档位「回到首次安装」还会清掉账号（org.json）、结算模板与全部登录态 —— 你需要重新登录，账号回到出厂默认。"
        />
      ) : null}
    </Space>
  ) : null

  const items = [
    {
      key: 'import',
      label: '导入备份恢复（W4-01）',
      children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="用「导出全部数据(JSON)」或快照备份文件整包覆盖当前数据。先预览差异，再入队，执行前自动打备份。"
          />
          <Space wrap>
            <Upload
              accept=".json"
              showUploadList={false}
              beforeUpload={(file) => {
                void onImportFile(file as File)
                return false
              }}
            >
              <Button disabled={!isBoss} loading={importBusy}>
                选择备份 JSON 文件
              </Button>
            </Upload>
            {importName ? <Typography.Text type="secondary">{importName}</Typography.Text> : null}
            <Button
              danger
              disabled={!isBoss || !importPreview}
              onClick={() => setImportOpen(true)}
            >
              入队导入恢复
            </Button>
          </Space>
          {importSummary ? (
            <div style={{ background: '#fafafa', padding: 12, borderRadius: 6 }}>{importSummary}</div>
          ) : null}
          <Input
            style={{ maxWidth: 480 }}
            placeholder="原因（可选，写入动作回执便于审计）"
            value={importReason}
            disabled={!isBoss}
            onChange={(e) => setImportReason(e.target.value)}
          />
        </Space>
      ),
    },
    {
      key: 'baseline',
      label: '重置为真实数据基线（W4-02）',
      children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="把整库重置为随包发布的真实数据基线（原料目录 + 进货/采购单 + 菜品）。销售 / 报价 / 流水 / 配方会被清空。"
          />
          <Space wrap>
            <Select
              style={{ minWidth: 320 }}
              placeholder={baselines.length ? '选择基线版本' : '暂无基线制品（bff/baselines/）'}
              value={baseVer}
              onChange={(v) => setBaseVer(v)}
              disabled={!isBoss || !baselines.length}
              options={baselines.map((b) => ({
                value: b.version,
                label: `${b.version} · 原料 ${b.counts.ings} / 菜品 ${b.counts.dishes} · ${b.generated_at ? b.generated_at.slice(0, 10) : '-'}`,
              }))}
            />
            <Button danger disabled={!isBoss || !basePreview} onClick={() => setBaseOpen(true)}>
              入队重置基线
            </Button>
          </Space>
          {baselineSummary}
          {basePreview?.baseline_source ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              基线来源：{basePreview.baseline_source}
            </Typography.Text>
          ) : null}
          <Input
            style={{ maxWidth: 480 }}
            placeholder="原因（可选）"
            value={baseReason}
            disabled={!isBoss}
            onChange={(e) => setBaseReason(e.target.value)}
          />
        </Space>
      ),
    },
    {
      key: 'clear',
      label: '清空全部业务数据（W4-03）',
      children: (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="两档粒度：只清业务（配置/账号保留）或回到首次安装状态。原料 / 进货单 / 库存流水必须同组清，否则下次重算会把库存算回来。"
          />
          <Radio.Group
            value={scope}
            disabled={!isBoss}
            onChange={(e) => setScope(e.target.value as 'business' | 'all')}
          >
            <Radio.Button value="business">只清业务数据（推荐）</Radio.Button>
            <Radio.Button value="all">回到首次安装状态</Radio.Button>
          </Radio.Group>
          {clearSummary}
          <Space wrap>
            <Button danger disabled={!isBoss || !clearPreview} onClick={() => setClearOpen(true)}>
              入队清空
            </Button>
            <Input
              style={{ maxWidth: 360 }}
              placeholder="原因（可选）"
              value={clearReason}
              disabled={!isBoss}
              onChange={(e) => setClearReason(e.target.value)}
            />
          </Space>
        </Space>
      ),
    },
  ]

  return (
    <Card
      title="高危数据维护"
      style={{ marginTop: 16 }}
      extra={
        <Typography.Text type="secondary">
          {isBoss ? '仅老板/店长 · 全部经审批队列执行' : tip}
        </Typography.Text>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="ADR-013 D4：三项均为覆盖式高危写，全部走 /api/actions 审批队列，执行前自动打快照备份（备份失败即拒绝执行）。"
      />
      <Tabs items={items} />

      <ConfirmWordModal
        open={importOpen}
        title="导入备份恢复（高危）"
        word={WORD_IMPORT}
        busy={importBusy}
        summary={importSummary}
        onCancel={() => setImportOpen(false)}
        onOk={() => void doImport()}
      />
      <ConfirmWordModal
        open={baseOpen}
        title="重置为真实数据基线（高危）"
        word={WORD_BASELINE}
        busy={baseBusy}
        summary={baselineSummary}
        onCancel={() => setBaseOpen(false)}
        onOk={() => void doResetBaseline()}
      />
      <ConfirmWordModal
        open={clearOpen}
        title={scope === 'all' ? '清空全部数据·回到首次安装（高危）' : '清空业务数据（高危）'}
        word={WORD_CLEAR}
        busy={clearBusy}
        summary={clearSummary}
        onCancel={() => setClearOpen(false)}
        onOk={() => void doClear()}
      />
    </Card>
  )
}
