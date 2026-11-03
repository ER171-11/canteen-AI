import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Empty,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { postAction } from '../../../api'
import { previewRecipeImport } from '../../../api/recipeImport'
import type {
  RecipeImportGroup,
  RecipeImportHead,
  RecipeImportLine,
  RecipeImportPreview,
} from '../../../api/recipeImport'
import { useAuthStore } from '../../../store/auth'
import { downloadRecipeTemplate } from '../recipeTemplate'

/**
 * FP-DISH-16 食谱卡批量导入 / FP-DISH-17 下载导入模板 / FP-DISH-18 未匹配自动建档。
 *
 * 移植自旧版：readImportFile(:3329) → parseRecTable(:3422) → previewRecImport(:3709) →
 * commitRecImport(:3754)；差异是把「解析」从浏览器 JS 挪到 BFF（lib/recipe_import.js，纯计算零写），
 * 云端与 App 共用同一套解析口径（与进货单导入 FP-RECV-02 同架构）。
 *
 * 红线（与 ADR-004 一致）：
 *   · **预览 = 只读**：previewRecipeImport 不写文件、不入队，可反复点。
 *   · **提交 = 一个动作**：整批只投一条 `recipe.import`，批内原子；确认前账面零变化。
 *   · 解析失败 / 不支持的格式一律**显式报错**，不静默丢弃任何一行（红线⑥）。
 *
 * 与旧版的关系（都写在界面上）：
 *   ① 未匹配原料/菜品**自动建档**（旧版 createIngFromImport / createDishFromImport 同款）：
 *      原料带文件里的「库存单位/原料分类」，菜品类型默认「常规」；建完再走 recipe.upsert，
 *      因此与手工「新增菜谱」是同一条写入口。
 *   ② 覆盖 / 合并：勾「覆盖」= 视为该菜配方的完整定义（覆盖主料并清空辅料/调味旧行）；
 *      不勾 = 按原料名合并用量，未出现的旧行保留（旧版 :3765-3769 同款）。
 *   ③ 旧版二进制 .xls（BIFF8）**不支持**，见界面提示（先另存为 .xlsx / CSV）。
 *   ④ 「手动指定列」已移植：列名古怪时可点开面板，指定表头行与「菜品名称/原料名称/净料用量」对应列。
 *   ⑤ 模板无「分组」列，导入明细统一记入**主料**；导入后可在「编辑配料」里调整分组。
 */

const SUPPORTED_FORMATS = [
  '.xlsx（Excel 2007+，二维规范表）',
  '.csv / .tsv（UTF-8 或 GBK，逗号/制表符自动识别）',
  '.json（{recipes:[…]} 或 {items:[…]}）',
  '.html / .htm（网页表格，即「伪 .xls」）',
]

const UNSUPPORTED = '暂不支持：旧版二进制 .xls（Excel 97-2003），请先另存为 .xlsx 或 CSV'

const REQUIRED_COLS = '必填列：菜品名称 + 原料名称 + 净料用量（同义词自动识别，如「菜名」「食材」「用量」）'

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => {
      const s = String(fr.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    fr.onerror = () => reject(fr.error || new Error('read failed'))
    fr.readAsDataURL(file)
  })
}

const lineCols: ColumnsType<RecipeImportLine> = [
  {
    title: '原料',
    dataIndex: 'name',
    render: (v: string, r) => (
      <Space size={4}>
        <span>{v}</span>
        {r.isNew ? <Tag color="orange">新增原料</Tag> : null}
        {r.cat ? <Tag>{r.cat}</Tag> : null}
      </Space>
    ),
  },
  { title: '净料用量', dataIndex: 'qty', width: 110, align: 'right' },
  { title: '单位', dataIndex: 'unit', width: 80 },
]

export interface RecipeImportModalProps {
  open: boolean
  onClose: () => void
  /** 入队成功后回调（父页刷新列表） */
  onQueued?: () => void
}

export default function RecipeImportModal({ open, onClose, onQueued }: RecipeImportModalProps) {
  const account = useAuthStore((s) => s.account)
  const role = useAuthStore((s) => s.role)
  const [busy, setBusy] = useState(false)
  const [fileName, setFileName] = useState('')
  /** 原文件 base64：手动指定列重解析时复用（服务端无状态，每次带全文重算） */
  const [fileB64, setFileB64] = useState('')
  const [preview, setPreview] = useState<RecipeImportPreview | null>(null)
  const [head, setHead] = useState<RecipeImportHead | null>(null)
  /** 覆盖（默认，旧版默认勾选） vs 按原料合并 */
  const [overwrite, setOverwrite] = useState(true)
  /* 手动指定列面板 */
  const [mapOpen, setMapOpen] = useState(false)
  const [headerRow, setHeaderRow] = useState(0)
  const [colMap, setColMap] = useState<Record<string, number>>({})

  const groups = useMemo<RecipeImportGroup[]>(() => preview?.groups ?? [], [preview])

  const reset = () => {
    setBusy(false)
    setFileName('')
    setFileB64('')
    setPreview(null)
    setHead(null)
    setOverwrite(true)
    setMapOpen(false)
    setHeaderRow(0)
    setColMap({})
  }

  const applyPreview = (pv: RecipeImportPreview) => {
    setPreview(pv)
    if (pv.head) {
      setHead(pv.head)
      setHeaderRow(pv.head.headerRowIndex >= 0 ? pv.head.headerRowIndex : 0)
      setColMap(pv.head.colMap ?? {})
    }
    message.success(`已预览：${pv.groups.length} 道菜 / ${pv.totalLines} 行`)
  }

  const runPreview = async (b64: string, name: string, override?: { rowIndex: number; map: Record<string, number> }) => {
    setBusy(true)
    try {
      const pv = await previewRecipeImport({ fileName: name, contentBase64: b64, override })
      applyPreview(pv)
      setMapOpen(false)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string; head?: RecipeImportHead } } }
      const data = err.response?.data
      setPreview(null)
      /* 列名识别不了时后端会把原始网格回传：直接展开「手动指定列」面板指路，不留死路 */
      if (data?.head) {
        setHead(data.head)
        setHeaderRow(data.head.headerRowIndex >= 0 ? data.head.headerRowIndex : 0)
        setColMap(data.head.colMap ?? {})
        setMapOpen(true)
      }
      message.error(data?.error || '预览失败（文件无法识别）')
    } finally {
      setBusy(false)
    }
  }

  const handleFile = async (file: File) => {
    setPreview(null)
    try {
      const b64 = await readAsBase64(file)
      setFileName(file.name)
      setFileB64(b64)
      await runPreview(b64, file.name)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '读取文件失败')
    }
  }

  const submit = async () => {
    if (!preview || !groups.length) return
    setBusy(true)
    try {
      await postAction({
        type: 'recipe.import',
        operator: role ?? account ?? 'admin',
        payload: {
          /* 整批一个动作（同 recv.import）：N 道菜的配方一次性进队列 */
          groups: groups.map((g) => ({
            dish: g.dish,
            cat: g.cat,
            rows: g.lines.map((l) => ({
              name: l.name,
              qty: l.qty,
              unit: l.unit,
              cat: l.cat,
            })),
          })),
          mode: overwrite ? 'replace' : 'merge',
          ensure_ings: true,
          sync_dish: true,
          source: 'admin-web/kitchen/recipes',
        },
      })
      message.success('食谱卡导入已入队 → 请到审批中心确认（确认后配方/原料/菜品才变）')
      onQueued?.()
      reset()
      onClose()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err.response?.data?.error || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  /* ---- 手动指定列：表头行候选 + 列选项（用该行单元格文字做标签） ---- */
  const headRows = useMemo(() => head?.rows ?? [], [head])
  const colOptions = useMemo(() => {
    const row = headRows[headerRow] || []
    const n = Math.max(row.length, headRows.reduce((m, r) => Math.max(m, r.length), 0))
    return Array.from({ length: n }, (_, i) => {
      const txt = String(row[i] ?? '').trim()
      return { value: i, label: txt ? `${txt}（第${i + 1}列）` : `第${i + 1}列` }
    })
  }, [headRows, headerRow])

  return (
    <Modal
      title="批量导入食谱卡"
      open={open}
      width={900}
      confirmLoading={busy}
      okText={preview ? `确认导入 ${groups.length} 道菜` : '确认导入'}
      okButtonProps={{ disabled: !preview || busy }}
      onOk={submit}
      onCancel={() => {
        reset()
        onClose()
      }}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space wrap>
          <Upload
            accept=".xlsx,.xls,.csv,.tsv,.json,.htm,.html"
            showUploadList={false}
            beforeUpload={(file) => {
              void handleFile(file as File)
              return false
            }}
          >
            <Button type="primary" loading={busy}>
              选择文件
            </Button>
          </Upload>
          <Button onClick={downloadRecipeTemplate}>下载导入模板</Button>
          {preview && fileB64 ? (
            <Button
              onClick={() => setMapOpen((v) => !v)}
              disabled={!head}
            >
              列识别不对？手动指定
            </Button>
          ) : null}
          {fileName ? <Typography.Text type="secondary">{fileName}</Typography.Text> : null}
        </Space>

        <Alert
          type="info"
          showIcon
          message={<span>支持格式：{SUPPORTED_FORMATS.join(' / ')}</span>}
          description={
            <div style={{ fontSize: 12 }}>
              <div>{REQUIRED_COLS}</div>
              <div style={{ color: '#cf1322' }}>{UNSUPPORTED}</div>
              <div>同一菜品多行即为多个原料；Excel 里菜品名的合并单元格会自动向下补齐。</div>
            </div>
          }
        />

        {mapOpen && head ? (
          <Alert
            type="warning"
            showIcon
            message="手动指定列：先点一行作为「表头行」，再把字段对到具体列"
            description={
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid #f0f0f0' }}>
                  <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                    <tbody>
                      {headRows.map((r, ri) => (
                        <tr
                          key={ri}
                          onClick={() => setHeaderRow(ri)}
                          style={{
                            cursor: 'pointer',
                            background: ri === headerRow ? '#fffbe6' : undefined,
                          }}
                        >
                          <td style={{ padding: '2px 6px', color: '#999', whiteSpace: 'nowrap' }}>
                            {ri + 1}
                          </td>
                          {r.map((c, ci) => (
                            <td
                              key={ci}
                              style={{
                                padding: '2px 8px',
                                borderLeft: '1px solid #f5f5f5',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {String(c ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Space wrap size="middle">
                  {head.fields.map((f) => (
                    <span key={f}>
                      <Typography.Text strong>{head.labels[f] ?? f}</Typography.Text>
                      <Select
                        size="small"
                        style={{ width: 170, marginLeft: 6 }}
                        allowClear
                        placeholder="不指定"
                        value={colMap[f]}
                        options={colOptions}
                        onChange={(v) =>
                          setColMap((prev) => {
                            const next = { ...prev }
                            if (v === undefined) delete next[f]
                            else next[f] = v as number
                            return next
                          })
                        }
                      />
                    </span>
                  ))}
                </Space>
                <Space>
                  <Button
                    type="primary"
                    size="small"
                    loading={busy}
                    onClick={() => void runPreview(fileB64, fileName, { rowIndex: headerRow, map: colMap })}
                  >
                    按此重新解析
                  </Button>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    必填：菜品名称 / 原料名称 / 净料用量
                  </Typography.Text>
                </Space>
              </Space>
            }
          />
        ) : null}

        {!preview && !busy && !mapOpen ? (
          <Empty description="先选一个文件：会先出预览，确认后才会入队（预览不改动任何数据）" />
        ) : null}

        {preview ? (
          <>
            <Space wrap size="middle">
              <Tag color="blue">识别格式：{preview.format}</Tag>
              <Tag>菜品 {preview.groups.length} 道</Tag>
              <Tag>明细 {preview.totalLines} 行</Tag>
              {preview.bad > 0 ? <Tag color="red">无效行剔除 {preview.bad} 行</Tag> : null}
              {preview.newDishes.length > 0 ? (
                <Tag color="blue">新增菜品 {preview.newDishes.length} 道（类型默认常规）</Tag>
              ) : null}
              {preview.unmatched.length > 0 ? (
                <Tag color="orange">新增原料 {preview.unmatched.length} 种（自动建档）</Tag>
              ) : null}
            </Space>

            {preview.newDishes.length > 0 || preview.unmatched.length > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={
                  <span>
                    {preview.newDishes.length > 0 ? (
                      <>
                        菜品档案没有：<b>{preview.newDishes.join('、')}</b>（导入时按「常规」新建）
                        <br />
                      </>
                    ) : null}
                    {preview.unmatched.length > 0 ? (
                      <>
                        原料档案没有：<b>{preview.unmatched.join('、')}</b>（导入时自动建档，带文件里的单位/分类）
                      </>
                    ) : null}
                  </span>
                }
                description="原料会出现在「原料库存」，库存 0、待采购入库后体现均价；菜品在「菜品菜单」可补售价/分类"
              />
            ) : null}

            <Radio.Group value={overwrite ? 'replace' : 'merge'} onChange={(e) => setOverwrite(e.target.value === 'replace')}>
              <Radio value="replace">覆盖同名菜品已有配方（视为该菜配方的完整定义）</Radio>
              <Radio value="merge">按原料合并用量（未出现的旧行保留）</Radio>
            </Radio.Group>

            <div style={{ maxHeight: 380, overflow: 'auto' }}>
              {groups.map((g, i) => (
                <div key={i} style={{ marginBottom: 12 }}>
                  <Space size={6} wrap>
                    <Typography.Text strong>{g.dish}</Typography.Text>
                    {g.isNewDish ? <Tag color="blue">新增菜品</Tag> : null}
                    {g.cat ? <Tag>{g.cat}</Tag> : null}
                    <Typography.Text type="secondary">
                      {g.lines.length} 种原料
                      {g.existing ? `（已有配方 ${g.existing} 行）` : '（未配置配方）'}
                    </Typography.Text>
                  </Space>
                  <Table<RecipeImportLine>
                    size="small"
                    rowKey={(r, ri) => `${r.ingId || r.name}-${ri ?? 0}`}
                    columns={lineCols}
                    dataSource={g.lines}
                    pagination={false}
                  />
                </div>
              ))}
            </div>

            <Alert
              type="warning"
              showIcon
              message="提交后进入审批中心，确认后由店内消费器写配方主数据"
              description={
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已知差异：① 明细统一记入「主料」（模板无分组列，与旧版一致），导入后可在「编辑配料」调整分组；
                  ② 未匹配原料带文件里的单位/分类建档，菜品按「常规」新建；
                  ③ 旧版二进制 .xls 不支持。
                </Typography.Text>
              }
            />
          </>
        ) : null}
      </Space>
    </Modal>
  )
}
