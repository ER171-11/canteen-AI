import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isAxiosError } from 'axios'
import {
  Alert,
  Card,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Button,
  Tooltip,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  fetchActions,
  confirmAction,
  rejectAction,
  fetchActionStatus,
  fetchSnapshot,
} from '../api'
import type { ActionItem } from '../api/types'
import { useAuthStore } from '../store/auth'
import { COLORS } from '../theme'
import { allValueOf, fromAll, withAll } from '../utils/filterAll'

/** 审批动作状态标签（与后端权威 5 态一一对应：queued 为入队初态英文遗留） */
const STATUS_TAG: Record<string, { color: string; text: string }> = {
  queued: { color: COLORS.yellow, text: '排队中' },
  待执行: { color: COLORS.green, text: '待执行' },
  已执行: { color: COLORS.purple, text: '已执行' },
  已驳回: { color: COLORS.red, text: '已驳回' },
  已过期: { color: 'default', text: '已过期' },
}

const OPEN = new Set(['queued'])
/** 终态：轮询到此为止 */
const TERMINAL = new Set(['已执行', '已驳回', '已过期'])

/**
 * 「待执行」超时未落库的判定阈值。
 *
 * 为什么要显性告警：审批通过**本身不写任何业务数据**——它只把 queued 放行成「待执行」，
 * 真正落库的是店内消费器（见 store-node/consumer.js：拉 待执行 → 店内三方合并落库 → 回调 execute）。
 * 消费器没在跑（如只起了 BFF）、或店内节点连的不是当前这套库（--db 指向不存在/写错的库 → 落到空库）时，
 * 动作会一直挂在「待执行」：审批中心看着像成功了，入库单/库存却永远不变。
 * 这里把它变成页面上的硬告警，避免「通过了却没数据」被静默吞掉。
 */
const STUCK_MS = 60 * 1000
/** 消费器周期（启动演练.cmd 为 5s）：超过它仍未执行，基本可判定没跟上 */
const CONSUMER_TICK_MS = 5000

/** 等待时长文案：< 60s 按秒，之后按「分 秒」 */
function waitText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)} 分 ${s % 60}s`
}

/** 该动作自「通过」起已等待多久（无 confirmed_at 时退化为 updated_at/created_at） */
function waitedMs(row: ActionItem): number {
  const t = new Date(row.confirmed_at ?? row.updated_at ?? row.created_at ?? 0).getTime()
  return Number.isFinite(t) ? Date.now() - t : 0
}

/** 轮询已确认单直到终态（消费器异步落库），最长约 20s */
async function pollUntilTerminal(id: string): Promise<string> {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const s = await fetchActionStatus(id)
      const st = String(s.status ?? '')
      if (TERMINAL.has(st)) return st
    } catch {
      /* 网络抖动继续等 */
    }
  }
  return ''
}

/** 透出服务端 error 字段（如 rev mismatch / invalid state / pending_provider），而非裸 axios 文案 */
function serverErrMsg(e: unknown): string {
  if (isAxiosError(e)) {
    const d = e.response?.data as { error?: string } | undefined
    return d?.error || e.message
  }
  return e instanceof Error ? e.message : String(e)
}

export default function ActionsPage() {
  const canWrite = useAuthStore((s) => s.canWrite)
  const noWriteTip = '当前角色无写权限，仅可查看'
  const [items, setItems] = useState<ActionItem[]>([])
  const [status, setStatus] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [offline, setOffline] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [selected, setSelected] = useState<React.Key[]>([])
  const [rejectReason, setRejectReason] = useState('')
  /* 受控分页：切筛选回第 1 页 */
  const [page, setPage] = useState(1)
  /* 同步竞态闸门：setBusyId 是异步 state，同一帧的双击拦不住，用 ref 兜底 */
  const busyRef = useRef(false)

  /**
   * 始终拉全量队列（不再把筛选值透传给服务端）：
   *   ① 队列本身很小；② 只有拿到全量才能给出准确的「待审批 N 条」；
   *   ③ 免掉「筛选值被当成 ?status=xxx 传出去 → 空列表」的隐患。
   */
  const load = useCallback(() => {
    setLoading(true)
    fetchActions()
      .then((list) => {
        setItems(list)
        setOffline(false)
      })
      .catch(() => {
        setItems([])
        setOffline(true)
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /**
   * 表格行 = 按状态筛选 + **按提交时间倒序**。
   *
   * 服务端 /api/actions 返回的是队列入库顺序（最老的在前 —— 消费器靠它做 FIFO），
   * 直接渲染会让「刚提交、待审批」的动作掉到最后一页（满 20 条/页时，第 51 条在第 3 页），
   * 看着就像「全部状态里看不到需要审批的操作」。审批台按时间倒序才符合直觉。
   */
  const rows = useMemo(() => {
    const list = status ? items.filter((r) => String(r.status) === status) : items
    return [...list].sort((a, b) =>
      String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
    )
  }, [items, status])

  /** 待人工拍板的数量（不受当前筛选影响，随时可见） */
  const pending = useMemo(
    () => items.filter((r) => String(r.status) === 'queued').length,
    [items],
  )

  /* 切筛选回到第 1 页：否则停留在第 N 页，筛出来的少量数据会落在「不存在的页」上 */
  useEffect(() => {
    setPage(1)
  }, [status])

  /* 队列里还有「待执行」时静默续刷（消费器周期 5s，取 2 倍）：执行一落库，顶部告警自动消失 */
  useEffect(() => {
    if (!items.some((r) => String(r.status) === '待执行')) return
    const t = setInterval(() => {
      fetchActions()
        .then(setItems)
        .catch(() => {
          /* 抖动不打断当前列表 */
        })
    }, CONSUMER_TICK_MS * 2)
    return () => clearInterval(t)
  }, [items])

  /* 已通过却迟迟没被消费器执行的动作（最久的排前面）——顶部硬告警用 */
  const stuck = useMemo(
    () =>
      items
        .filter((r) => String(r.status) === '待执行')
        .map((r) => ({ id: r.id, ms: waitedMs(r) }))
        .filter((x) => x.ms >= STUCK_MS)
        .sort((a, b) => b.ms - a.ms),
    [items],
  )

  const doConfirm = async (row: ActionItem) => {
    const snap = await fetchSnapshot().catch(() => null)
    const rev = snap?.rev != null ? String(snap.rev) : undefined
    try {
      await confirmAction(row.id, { operator: 'admin', rev })
    } catch (e: unknown) {
      /* 准入提示锁冲突：云端快照 rev 可能刚被 pusher 回写推进（消费器推进的是店内 rev，
         云端快照要等 pusher 才跟进）。取最新快照 rev 重试一次（仍失败则抛出）。
         真正的落库安全由店内三方合并兜底，此处的 409 只是早期反馈。 */
      if (isAxiosError(e) && e.response?.status === 409 && /rev mismatch/.test(serverErrMsg(e))) {
        const fresh = await fetchSnapshot().catch(() => null)
        const rev2 = fresh?.rev != null ? String(fresh.rev) : undefined
        await confirmAction(row.id, { operator: 'admin', rev: rev2 })
      } else {
        throw e
      }
    }
    /* 已确认（待执行）后轮询执行结果直至终态 */
    const final = await pollUntilTerminal(row.id)
    return final
  }

  const onConfirm = async (row: ActionItem) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyId(row.id)
    try {
      const final = await doConfirm(row)
      if (final) {
        message.success(`已执行完成 ${row.id}（${final}）：店内数据已落库，相关页面刷新即可见`)
      } else {
        /* 只放行、没落库：必须说清「数据还没变」，否则用户会以为审批过了单子就该出现 */
        message.warning(
          `已通过 ${row.id}，但 20s 内店内消费器未执行：数据还没落库（入库单/库存不会变）。` +
            '请确认消费器在运行（「启动演练.cmd」会一并拉起），修好后队列自动续跑，无需重新提交。',
        )
      }
      load()
    } catch (e: unknown) {
      const msg = serverErrMsg(e)
      if (/invalid state/.test(msg)) {
        /* 该单已不在 queued（多半刚才那次点击其实已成功），刷新即可，不算错误 */
        message.warning(`该申请状态已变化，无需重复通过（${row.id}），列表已刷新`)
      } else {
        message.error(`通过失败：${msg}`)
      }
      load()
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }

  const onReject = async (row: ActionItem, reason: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyId(row.id)
    try {
      await rejectAction(row.id, { reason: reason.trim() || '管理端驳回' })
      message.success(`已驳回 ${row.id}`)
      load()
    } catch (e: unknown) {
      const msg = serverErrMsg(e)
      if (/invalid state/.test(msg)) {
        message.warning(`该申请状态已变化，无需重复驳回（${row.id}），列表已刷新`)
      } else {
        message.error(`驳回失败：${msg}`)
      }
      load()
    } finally {
      busyRef.current = false
      setBusyId(null)
    }
  }

  /* 可选中的行 = 当前列表里仍处于「排队中」的行（用筛选/排序后的 rows，与所见一致） */
  const openRows = rows.filter((r) => OPEN.has(String(r.status)))
  const selectedRows = openRows.filter((r) => selected.includes(r.id))

  const onBatch = async (kind: 'confirm' | 'reject') => {
    if (!selectedRows.length) return
    setBatchBusy(true)
    let ok = 0
    let fail = 0
    for (const row of selectedRows) {
      try {
        if (kind === 'confirm') {
          await doConfirm(row)
        } else {
          await rejectAction(row.id, { reason: rejectReason.trim() || '管理端批量驳回' })
        }
        ok++
      } catch {
        fail++
      }
    }
    message[fail ? 'warning' : 'success'](
      `批量${kind === 'confirm' ? '通过' : '驳回'}：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}`,
    )
    setSelected([])
    setRejectReason('')
    setBatchBusy(false)
    load()
  }

  const columns: ColumnsType<ActionItem> = [
    { title: 'ID', dataIndex: 'id', width: 140, ellipsis: true },
    { title: '类型', dataIndex: 'type', width: 140 },
    {
      title: '标题',
      dataIndex: 'title',
      render: (v: string | undefined, r) =>
        v ?? (r.payload ? `${r.type} ${JSON.stringify(r.payload)}` : r.type),
      ellipsis: true,
    },
    {
      title: '发起人',
      dataIndex: 'initiator',
      width: 100,
      render: (v: string | undefined, r) => v ?? r.operator ?? '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 160,
      render: (s: string, r) => {
        const tag = STATUS_TAG[s] ?? { color: 'default', text: s }
        const ms = String(s) === '待执行' ? waitedMs(r) : 0
        return (
          <Space size={4}>
            <Tag color={tag.color}>{tag.text}</Tag>
            {ms >= STUCK_MS && (
              <Tooltip title="已通过但店内消费器还没落库：入库单/库存不会变。详见顶部告警。">
                <span style={{ color: COLORS.red, fontSize: 12 }}>等待{waitText(ms)}</span>
              </Tooltip>
            )}
          </Space>
        )
      },
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      width: 180,
      render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-'),
    },
    {
      title: '操作',
      key: 'op',
      width: 180,
      render: (_, row) => {
        const open = OPEN.has(String(row.status))
        return (
          <Space>
            <Tooltip title={canWrite ? undefined : noWriteTip}>
              <Button
                size="small"
                type="primary"
                disabled={!open || !canWrite || busyId === row.id || batchBusy}
                loading={busyId === row.id}
                onClick={() => onConfirm(row)}
              >
                通过
              </Button>
            </Tooltip>
            <Tooltip title={canWrite ? undefined : noWriteTip}>
              <span>
                <Popconfirm
                  title="驳回该申请"
                  description={
                    <Input.TextArea
                      rows={2}
                      style={{ width: 240 }}
                      placeholder="驳回原因（可选，默认：管理端驳回）"
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                    />
                  }
                  okText="确认驳回"
                  cancelText="取消"
                  onConfirm={() => {
                    onReject(row, rejectReason)
                    setRejectReason('')
                  }}
                  onCancel={() => setRejectReason('')}
                  disabled={!open || !canWrite || busyId === row.id}
                >
                  <Button
                    size="small"
                    danger
                    disabled={!open || !canWrite || busyId === row.id || batchBusy}
                    loading={busyId === row.id}
                  >
                    驳回
                  </Button>
                </Popconfirm>
              </span>
            </Tooltip>
          </Space>
        )
      },
    },
  ]

  return (
    <Card
      title="审批中心（动作队列）"
      extra={
        <Space wrap>
          {/* 待人工拍板的数量：不管当前筛选是什么都看得到，避免「提交了却以为没进来」 */}
          {pending > 0 && (
            <Tooltip title="还有这些申请在排队中，需要人工通过或驳回">
              <Tag color={COLORS.yellow}>待审批 {pending}</Tag>
            </Tooltip>
          )}
          {/* 首项固定「全部状态」：不筛选=看全部动作，且随时一键退回全部 */}
          <Select
            allowClear
            placeholder="按状态筛选"
            style={{ width: 140 }}
            value={allValueOf(status)}
            onChange={(v) => setStatus(fromAll<string>(v))}
            options={withAll(
              [
                { value: 'queued', label: '排队中' },
                { value: '待执行', label: '待执行' },
                { value: '已执行', label: '已执行' },
                { value: '已驳回', label: '已驳回' },
                { value: '已过期', label: '已过期' },
              ],
              '全部状态',
            )}
          />
        </Space>
      }
    >
      {offline && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="BFF 未连接（/api/actions 不可用），暂无数据。断网期间店内无法录入、待执行动作也不会推进；网络恢复后队列自动续跑，不会丢失。"
        />
      )}
      {stuck.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            `有 ${stuck.length} 条申请「已通过但未被执行」（最久已等待 ${waitText(stuck[0].ms)}）：` +
            '这些动作还没有落库，所以入库单 / 库存 / 欠款都不会有变化。'
          }
          description={
            <div>
              审批通过只负责放行（queued→待执行），真正写库的是店内消费器。常见原因：
              <br />
              ① <b>消费器没在运行</b>：只启动了 BFF + 网页时不会有人执行队列；用「启动演练.cmd」启动会自动拉起
              consumer（5s 轮询）+ pusher。
              <br />
              ② <b>店内节点连的不是这套库</b>：店内服务 <code>--db</code> 指向不存在的库时会新建一个空库，
              动作就落进了那个空库，云端快照因此不变（本页却显示已通过）。
              <br />
              修好任一处后队列按 5s 周期自动续跑，<b>无需重新提交</b>；本页每 10s 自动刷新，无需手点。
            </div>
          }
        />
      )}
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="审批中心 = 动作队列状态机，与原生 App 共用 /api/actions，同源可见。"
        description={
          <div>
            「通过」= 放行到待执行（queued→待执行；校验的是云端快照 rev 的准入提示，落库由店内消费器三方合并兜底）；「驳回」= 直接关闭。
            <br />
            「通过」本身不写业务数据：入库单 / 库存要等店内消费器执行完成（状态变「已执行」）才可见。
            <br />
            列表<b>按提交时间倒序</b>（最新提交的在最前）；筛选框默认「全部状态」= 不筛，排队中 / 待执行 / 已完成的都在里面。
            <br />
            SI 来源的动作命中政策时会自动放行、无需人工通过；断网时队列暂停推进，恢复后自动续跑。
          </div>
        }
      />
      {canWrite && (
        <Space style={{ marginBottom: 12 }} wrap>
          <Popconfirm
            title={`批量通过 ${selectedRows.length} 条申请？`}
            okText="通过"
            cancelText="取消"
            disabled={!selectedRows.length || batchBusy}
            onConfirm={() => onBatch('confirm')}
          >
            <Button type="primary" disabled={!selectedRows.length} loading={batchBusy}>
              批量通过{selectedRows.length ? `（${selectedRows.length}）` : ''}
            </Button>
          </Popconfirm>
          <Popconfirm
            title={`批量驳回 ${selectedRows.length} 条申请？`}
            description={
              <Input.TextArea
                rows={2}
                style={{ width: 240 }}
                placeholder="驳回原因（可选，默认：管理端批量驳回）"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            }
            okText="确认驳回"
            cancelText="取消"
            disabled={!selectedRows.length || batchBusy}
            onConfirm={() => onBatch('reject')}
          >
            <Button danger disabled={!selectedRows.length} loading={batchBusy}>
              批量驳回{selectedRows.length ? `（${selectedRows.length}）` : ''}
            </Button>
          </Popconfirm>
        </Space>
      )}
      <Table<ActionItem>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        rowSelection={
          canWrite
            ? {
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys),
                getCheckboxProps: (r) => ({ disabled: !OPEN.has(String(r.status)) }),
              }
            : undefined
        }
        pagination={{
          current: page,
          pageSize: 20,
          onChange: setPage,
          showSizeChanger: false,
          showTotal: (t) => `共 ${t} 条（按提交时间倒序，最新在前）`,
        }}
      />
    </Card>
  )
}
