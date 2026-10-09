import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchAnalysisTrend,
  fetchAnalysisHeat,
  fetchAnalysisEfficiency,
  type AnalysisTrendPoint,
  type AnalysisHeatPoint,
  type AnalysisEfficiency,
} from '../api'

export type Period = 'today' | 'yesterday' | 'thisweek' | 'lastweek' | 'thismonth'
export type PeriodStatus = 'idle' | 'loading' | 'success' | 'error'

export const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'thisweek', label: '本周' },
  { key: 'lastweek', label: '上周' },
  { key: 'thismonth', label: '本月' },
]

interface Snap {
  trend: AnalysisTrendPoint[]
  heat: AnalysisHeatPoint[]
  efficiency: AnalysisEfficiency | null
}

function cacheKey(p: Period) {
  return 'analysis:' + p
}
function loadCache(p: Period): Snap | null {
  try {
    const raw = localStorage.getItem(cacheKey(p))
    return raw ? (JSON.parse(raw) as Snap) : null
  } catch {
    return null
  }
}
function saveCache(p: Period, s: Snap) {
  try {
    localStorage.setItem(cacheKey(p), JSON.stringify(s))
  } catch {
    /* 忽略配额错误 */
  }
}

/**
 * docx M1-T4 时段切换状态机：
 *   idle -> loading -> success | error
 * - 并行三组查询（trend/heat/efficiency），5s 超时
 * - 300ms 防抖，避免频繁切换
 * - 成功结果缓存到 localStorage；失败回退上次成功快照（不白屏）
 */
export function useAnalysisPeriod() {
  const [period, setPeriod] = useState<Period>('thisweek')
  const [status, setStatus] = useState<PeriodStatus>('idle')
  const [trend, setTrend] = useState<AnalysisTrendPoint[]>([])
  const [heat, setHeat] = useState<AnalysisHeatPoint[]>([])
  const [efficiency, setEfficiency] = useState<AnalysisEfficiency | null>(null)
  const [error, setError] = useState<string | null>(null)
  const lastSnap = useRef<Snap | null>(null)
  const debounce = useRef<ReturnType<typeof setTimeout>>()

  const run = useCallback((p: Period) => {
    setStatus('loading')
    setError(null)
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    Promise.race([
      Promise.all([fetchAnalysisTrend(), fetchAnalysisHeat(), fetchAnalysisEfficiency()]),
      timeout,
    ])
      .then((res) => {
        const [t, h, e] = res as [AnalysisTrendPoint[], AnalysisHeatPoint[], AnalysisEfficiency | null]
        const snap: Snap = { trend: t, heat: h, efficiency: e }
        lastSnap.current = snap
        setTrend(t)
        setHeat(h)
        setEfficiency(e)
        setStatus('success')
        saveCache(p, snap)
      })
      .catch(() => {
        const cached = loadCache(p)
        if (cached) {
          lastSnap.current = cached
          setTrend(cached.trend)
          setHeat(cached.heat)
          setEfficiency(cached.efficiency)
          setStatus('success')
        } else {
          setStatus('error')
          setError('数据异常')
        }
      })
  }, [])

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => run(period), 300)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [period, run])

  return { period, setPeriod, status, trend, heat, efficiency, error }
}
