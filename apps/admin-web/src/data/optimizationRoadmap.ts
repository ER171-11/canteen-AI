/*
 * 系统优化方向路线图 · 前端展示数据源
 *
 * 唯一权威来源：`docs/治理与待办/待治理-系统优化方向路线图.md`
 * （生成日期 2026-10-28，状态：草案）。本文件把文档中的「阶段表 / 各章节项」
 * 编码为前端可渲染的结构；进度/状态随文档更新而在此手动同步（非运行时拉取）。
 *
 * 进度口径：
 *   - 阶段（P0–P4）依据文档 §七「推进顺序建议」表的完成标记。
 *   - 章节项（1.1 / 2.1 …）依据文档各 § 的「现状依据 / 已拍板 / 已完成」标注。
 */

export type Status = 'done' | 'in_progress' | 'pending' | 'blocked'
export type Risk = '低' | '中' | '高'

export interface RoadmapItem {
  id: string
  title: string
  status: Status
  /** 0–100，章节项颗粒度的完成度估算 */
  progress: number
  owner?: string
  risk?: Risk
  depends?: string
  /** 一句话现状/价值摘要 */
  note?: string
}

export interface RoadmapSection {
  id: string
  title: string
  summary: string
  items: RoadmapItem[]
}

export interface RoadmapPhase {
  id: string
  title: string
  content: string
  depends: string
  risk: Risk
  status: Status
  progress: number
}

export const ROADMAP_META = {
  title: '系统优化方向路线图',
  generatedAt: '2026-10-28',
  status: '草案（待评审 / 待指派负责人）',
  source: 'docs/治理与待办/待治理-系统优化方向路线图.md',
  /** 当前基线：FP 基线 151 项已移植 136 项，剩 11 张欠账卡 */
  baseline: 'FP 基线 151 项中已移植 136 项，剩 11 张欠账卡（W2 4 / W3 4 / W4 3）',
}

/** §七 推进顺序（P0 接缝已完，P1–P4 待启动/受阻） */
export const ROADMAP_PHASES: RoadmapPhase[] = [
  {
    id: 'P0',
    title: 'P0 · 接缝层（ADR-010 Phase 0）',
    content:
      'store-adapter json/sqlite/pg + action-runner + 独立 worker + 契约测试双绿；默认仍 json，运行时读写行为不变。',
    depends: '无（无需云权限）',
    risk: '低',
    status: 'done',
    progress: 100,
  },
  {
    id: 'P1',
    title: 'P1 · 低风险业务收口',
    content: '并行收口低风险欠账：W2 全清 + W3 四项（替换「待指派」为真人）。',
    depends: '无',
    risk: '低',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'P2',
    title: 'P2 · 原料数据质量',
    content: 'conv 换算失真修复 + 别名/同义词机制（代码层），再做人工归位与四列补填。',
    depends: '无',
    risk: '中',
    status: 'pending',
    progress: 0,
  },
  {
    id: 'P3',
    title: 'P3 · 云端底座迁移 + 防漂移',
    content: 'ADR-010 Phase 1–3（建库 → 迁移切流 → 本地退场）+ 桌面端防漂移改造（§4.1）。',
    depends: 'P0 + 腾讯云权限 + 业务窗口',
    risk: '高',
    status: 'blocked',
    progress: 0,
  },
  {
    id: 'P4',
    title: 'P4 · 高危与现场验证收尾',
    content: 'W4 高危三项 + 断网实测（§5.1）+ 发版自检脚本化（§6.2）收尾。',
    depends: 'P1 / P3',
    risk: '中',
    status: 'pending',
    progress: 0,
  },
]

/** 一～六 章节项（颗粒度对齐文档各 §） */
export const ROADMAP_SECTIONS: RoadmapSection[] = [
  {
    id: 'arch',
    title: '一、架构底座（最高杠杆，当前最大技术债）',
    summary:
      '主存仍是每台终端本地 snapshot.json（默认 STORE_ADAPTER=json），账本分散、无中心化；ADR-010 已拍板迁腾讯云 PostgreSQL，但代码尚未切流。',
    items: [
      {
        id: '1.1',
        title: '1.1 落地 ADR-010（云端单一主存）',
        status: 'in_progress',
        progress: 30,
        owner: '待指派（架构）',
        risk: '高',
        depends: 'P0 → 腾讯云权限',
        note: 'Phase 0 接缝层已完成（2026-10-28）；运行时主存形态未变，D0–D3 已拍板，Phase 1–3 待腾讯云权限启动。',
      },
      {
        id: '1.2',
        title: '1.2 跨端数据同步',
        status: 'pending',
        progress: 0,
        owner: '待指派（架构）',
        risk: '中',
        depends: 'ADR-010 完成',
        note: 'ADR-011 预留的「终端本地主存 → 云端 → 桌面」增量同步机制，待 ADR-010 完成后设计，避免提前重复工作。',
      },
    ],
  },
  {
    id: 'biz',
    title: '二、业务功能收口（最直接可见价值）',
    summary: '依据欠账总表，11 张卡当前负责人全为「待指派」，落地前需替换为真人。',
    items: [
      {
        id: '2.1',
        title: '2.1 清空剩余 11 张欠账卡',
        status: 'pending',
        progress: 0,
        owner: '待指派（按 W2/W3/W4 分组）',
        risk: '中',
        depends: 'P1',
        note:
          'W2 业务闭环 4 项（低风险）/ W3 录入类 4 项（走审批队列，W3-03 带引用保护）/ W4 高危 3 项（双人确认+审批留痕，放最后单独评审）。',
      },
    ],
  },
  {
    id: 'data',
    title: '三、数据与主数据治理（影响所有报表口径）',
    summary: '原料主数据是所有成本/损耗/比价报表正确的前提，是数据质量真源头。',
    items: [
      {
        id: '3.1',
        title: '3.1 原料主数据收口',
        status: 'in_progress',
        progress: 35,
        owner: '待指派（数据）',
        risk: '中',
        depends: '无',
        note:
          'type 语义分层（food/consumable）五处口径过滤已落地（rev 280）；剩 conv 换算失真 + 无别名机制（更深未解），及人工归位（19 错位 + 62 暂落「其他」+ cat 收敛）。',
      },
      {
        id: '3.2',
        title: '3.2 报表口径一致性实证',
        status: 'pending',
        progress: 0,
        owner: '待指派（数据）',
        risk: '中',
        depends: '3.1',
        note: '成本/损耗/比价/补货/经营分析是否真按 isFood 过滤全对，没有断言保障，需补回归断言。',
      },
    ],
  },
  {
    id: 'eng',
    title: '四、工程效率与防漂移',
    summary: '消除「改了没同步」的静默事故与测试噪声，作为发版门禁护栏。',
    items: [
      {
        id: '4.1',
        title: '4.1 桌面端双副本同步漂移风险',
        status: 'pending',
        progress: 0,
        owner: '待指派（工程）',
        risk: '中',
        depends: 'P3',
        note: 'sync-assets 靠 mtime 比对，schema/算法副本易漏同步；二选一：构建期硬校验 diff 不一致即 exit(1)，或改内容哈希比对。',
      },
      {
        id: '4.2',
        title: '4.2 移动端契约一致性',
        status: 'pending',
        progress: 0,
        owner: '待指派（工程）',
        risk: '低',
        depends: '无',
        note: 'BFF ↔ KMP（Android/iOS 共享层）接口契约未见契约测试，拟补一份作为发版门禁。',
      },
      {
        id: '4.3',
        title: '4.3 算法层「无关失败」清零',
        status: 'in_progress',
        progress: 90,
        owner: '待指派（工程）',
        risk: '低',
        depends: '无',
        note: '算法层长期 23/25，两个 dish 用例「无关失败」，须定位清零让 npm test 回到真全绿。',
      },
    ],
  },
  {
    id: 'obs',
    title: '五、可观测性与现场验证',
    summary: '断网降级政策已定（沿用 ADR-009 只读），剩现场实测与审计可视化敞口。',
    items: [
      {
        id: '5.1',
        title: '5.1 断网降级现场实测',
        status: 'pending',
        progress: 0,
        owner: '待指派（现场）',
        risk: '中',
        depends: 'P3',
        note: 'ADR-010 §9 已拍板只读降级；店内「断网 → 只读可用 → 恢复自动续跑」实测尚未执行，敞口未关闭。',
      },
      {
        id: '5.2',
        title: '5.2 红线 / 审计可视化',
        status: 'pending',
        progress: 0,
        owner: '待指派（平台）',
        risk: '低',
        depends: '无',
        note: 'SI 自动放行有审计+可回滚但无可视化看板；审批中心拟增「自动放行记录」视图，避免绕过审批误读。',
      },
    ],
  },
  {
    id: 'sec',
    title: '六、安全与交付',
    summary: '把发版前检查固化为 CI 门禁，防止密钥误提交与人工漏检。',
    items: [
      {
        id: '6.1',
        title: '6.1 secret 与 .gitignore 复核',
        status: 'pending',
        progress: 0,
        owner: '待指派（安全）',
        risk: '中',
        depends: '无',
        note: '交接 zip 带过 bff/.env、tokens.json 等；须确认是否已轮换且真在 .gitignore，固化 git clean -xdn 检查进 ci/redline_guard。',
      },
      {
        id: '6.2',
        title: '6.2 发版自检脚本化',
        status: 'pending',
        progress: 0,
        owner: '待指派（工程）',
        risk: '低',
        depends: '无',
        note: '发版后自查（curl releases/latest 返回新版本号 + Release 资产含 exe/latest.yml/blockmap）固化成 scripts/verify-release.js。',
      },
    ],
  },
]

/** 状态 → 展示文案 / 颜色 */
export const STATUS_META: Record<Status, { text: string; color: string }> = {
  done: { text: '已完成', color: '#5BA85B' },
  in_progress: { text: '进行中', color: '#3A6EA5' },
  pending: { text: '待启动', color: '#8C8C8C' },
  blocked: { text: '受阻', color: '#E8584A' },
}

/** 风险 → 颜色 */
export const RISK_COLOR: Record<Risk, string> = {
  低: '#5BA85B',
  中: '#F2B233',
  高: '#E8584A',
}

/** 聚合：总进度（章节项平均完成度）与状态计数 */
export function aggregate() {
  const items = ROADMAP_SECTIONS.flatMap((s) => s.items)
  const total = items.length
  const sum = items.reduce((a, it) => a + it.progress, 0)
  const overall = total ? Math.round((sum / total) * 10) / 10 : 0
  const counts: Record<Status, number> = { done: 0, in_progress: 0, pending: 0, blocked: 0 }
  items.forEach((it) => {
    counts[it.status] += 1
  })
  return { total, overall, counts }
}
