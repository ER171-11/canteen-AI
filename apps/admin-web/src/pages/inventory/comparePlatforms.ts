/*
 * 外接比价平台配置（共享常量 + 纯函数）
 *
 * 口径来源（旧版 HTML）：
 *   · 默认平台表 DEF_PLATFORMS —— HTML:765-771（1688批发/京东/淘宝/拼多多/百度爱采购/美菜商城）
 *   · 关键词外链构建 pricePop  —— HTML:1178-1182（tpl 含 `{kw}` 时替换为 encodeURIComponent(关键词)）
 *   · 设置页平台表渲染/增删    —— HTML:5230-5235 / :5277-5283（名称 + 搜索URL 模板）
 *
 * 存储：`data.config.compare_platforms`（数组 `{ name, tpl }`）。
 * 注意：快照 `data.platforms` 是**外卖平台经营数据**（美团/饿了么），与之同名不同义，勿混用。
 * 写入走 BFF `POST /api/admin/config`（type=config.update，仅老板/店长，经审批队列）。
 */

export type ComparePlatform = { name: string; tpl: string }

/** 旧版 `DEF_PLATFORMS`（HTML:765-771）逐行照抄 */
export const DEF_COMPARE_PLATFORMS: ComparePlatform[] = [
  { name: '1688批发', tpl: 'https://s.1688.com/selloffer/offer_search.htm?keywords={kw}' },
  { name: '京东', tpl: 'https://search.jd.com/Search?keyword={kw}&enc=utf-8' },
  { name: '淘宝', tpl: 'https://s.taobao.com/search?q={kw}' },
  { name: '拼多多', tpl: 'https://mobile.yangkeduo.com/search_result.html?search_key={kw}' },
  { name: '百度爱采购', tpl: 'https://b2b.baidu.com/s?q={kw}' },
  { name: '美菜商城', tpl: 'https://www.mallcai.com/' },
]

/**
 * 归一化平台列表：非数组回落默认表；逐项只保留 `{name, tpl}` 字符串；丢弃全空项。
 * 用于把快照里可能缺失/脏的 `config.compare_platforms` 收敛成可渲染的数据。
 */
export function normalizeComparePlatforms(v: unknown): ComparePlatform[] {
  if (!Array.isArray(v)) return DEF_COMPARE_PLATFORMS.map((p) => ({ ...p }))
  return v
    .filter((x) => x && typeof x === 'object')
    .map((x) => {
      const o = x as Record<string, unknown>
      return { name: String(o.name ?? '').trim(), tpl: String(o.tpl ?? '').trim() }
    })
    .filter((p) => p.name || p.tpl)
}

/** 关键词外链：tpl 含 `{kw}` 时替换（encodeURIComponent），否则原样返回（同旧版 pricePop） */
export function comparePlatformUrl(tpl: string, kw: string): string {
  return String(tpl || '').includes('{kw}')
    ? String(tpl).replace('{kw}', encodeURIComponent(String(kw ?? '')))
    : String(tpl || '')
}
