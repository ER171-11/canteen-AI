/*
 * mobile-e1e2-verify.mjs — E1/E2 验收
 *   E1 手机壳：汉堡开抽屉、抽屉含菜单、点菜单跳转并自动收起
 *   E2 入库卡片：375/390 下无横向滚动、无屏外按钮、卡片含关键字段
 *   PC 回归：桌面端侧栏、表格、KPI 四列均未被改动影响
 * 只读：不点任何写操作（新建/确认/作废等）。
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/D-手机浏览器兜底'
const out = { checks: [], errors: [] }
fs.mkdirSync(SHOT_DIR, { recursive: true })

const ok = (name, cond, detail) => {
  out.checks.push({ name, pass: !!cond, ...(detail ? { detail } : {}) })
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + JSON.stringify(detail) : ''))
}

async function login(page, account) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 20000 })
  await page.fill('input[placeholder="岗位账号"]', account)
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard/, { timeout: 20000 })
}

let browser
try {
  browser = await chromium.launch({ headless: true })

  /* ----------------- E1：手机抽屉 ----------------- */
  const mctx = await browser.newContext({ ...devices['iPhone 13'] })
  const mp = await mctx.newPage()
  mp.on('pageerror', (e) => out.errors.push(String(e)))
  await login(mp, 'manager')
  await mp.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await mp.waitForSelector('text=进货入库', { timeout: 20000 })
  await mp.waitForTimeout(800)

  // 侧栏应不可见（收进抽屉）
  const siderHidden = await mp.evaluate(() => {
    const s = document.querySelector('.ant-layout-sider')
    return !s || s.offsetParent === null || s.getBoundingClientRect().width === 0
  })
  ok('手机端侧边栏不占屏', siderHidden)

  // 点汉堡 → 抽屉出现
  await mp.click('button[aria-label="打开菜单"]')
  await mp.waitForTimeout(700)
  const drawer = await mp.evaluate(() => {
    const d = document.querySelector('.ant-drawer-content')
    if (!d) return null
    const items = Array.from(d.querySelectorAll('.ant-menu-title-content')).map((e) => e.textContent.trim())
    return { visible: true, menuItemCount: items.length, sample: items.slice(0, 4) }
  })
  ok('汉堡可打开导航抽屉', !!drawer && drawer.menuItemCount > 0, drawer)
  await mp.screenshot({ path: path.join(SHOT_DIR, '12-手机端导航抽屉.png') })

  // 点菜单项 → 跳转并自动收起
  const target = mp.locator('.ant-drawer-content .ant-menu-title-content', { hasText: '采购单' }).first()
  let jumped = false
  if (await target.count() > 0) {
    await target.click()
    await mp.waitForTimeout(1200)
    jumped = /inventory\/purchase/.test(mp.url())
  }
  const drawerClosed = await mp.evaluate(() => {
    const d = document.querySelector('.ant-drawer')
    return !d || !d.className.includes('ant-drawer-open')
  })
  ok('点抽屉菜单可跳转', jumped, { url: mp.url() })
  ok('换页后抽屉自动收起', drawerClosed)

  /* ----------------- E2：卡片列表度量 ----------------- */
  await mp.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await mp.waitForSelector('text=进货入库', { timeout: 20000 })
  await mp.waitForTimeout(1000)
  const card = await mp.evaluate(() => {
    const vw = window.innerWidth
    const de = document.documentElement
    const cards = Array.from(document.querySelectorAll('.ant-card'))
      .filter((c) => /JH|JS-/.test(c.textContent || ''))
    const btns = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.offsetParent !== null)
      .filter((b) => {
        const r = b.getBoundingClientRect()
        return r.left < 0 || r.right > vw + 1
      })
      .map((b) => (b.textContent || '').trim())
    const first = cards[0]
    const firstText = first ? (first.textContent || '').replace(/\s+/g, ' ') : ''
    return {
      innerWidth: vw,
      docScrollWidth: de.scrollWidth,
      noHorizontalScroll: de.scrollWidth <= vw + 1,
      hasTable: !!document.querySelector('.ant-table'),
      cardCount: cards.length,
      offscreenButtons: btns,
      firstCard: firstText.slice(0, 120),
      firstCardHasNo: /JH\d{8}-\d{2}/.test(firstText),
      firstCardHasAmount: /应付/.test(firstText),
      firstCardHasSettleBtn: !!first && /结算单/.test(firstText),
    }
  })
  ok('手机端无整体缩放（innerWidth=视口宽）', card.innerWidth === 390, { innerWidth: card.innerWidth })
  ok('手机端无横向滚动', card.noHorizontalScroll, { docScrollWidth: card.docScrollWidth })
  ok('手机端不再渲染 1456px 宽表格', !card.hasTable)
  ok('卡片列表已渲染', card.cardCount > 0, { cardCount: card.cardCount })
  ok('无屏外按钮', card.offscreenButtons.length === 0, card.offscreenButtons)
  ok('卡片含单号/金额/结算入口', card.firstCardHasNo && card.firstCardHasAmount && card.firstCardHasSettleBtn, card.firstCard)

  /* 触控尺寸：主操作按钮 ≥ 40px 高 */
  const touch = await mp.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('.ant-card button'))
      .filter((b) => b.offsetParent !== null)
      .map((b) => Math.round(b.getBoundingClientRect().height))
    return { min: btns.length ? Math.min(...btns) : null, count: btns.length }
  })
  ok('卡片操作按钮触控高度 ≥ 40px', touch.min !== null && touch.min >= 40, touch)
  await mp.screenshot({ path: path.join(SHOT_DIR, '13-手机端卡片列表.png'), fullPage: false })
  await mctx.close()

  /* ----------------- PC 回归 ----------------- */
  const pctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const pp = await pctx.newPage()
  pp.on('pageerror', (e) => out.errors.push(String(e)))
  await login(pp, 'boss')
  await pp.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await pp.waitForSelector('.ant-table', { timeout: 20000 })
  await pp.waitForTimeout(1000)
  const pc = await pp.evaluate(() => {
    const sider = document.querySelector('.ant-layout-sider')
    const cols = document.querySelectorAll('.ant-table-thead th')
    const kpiCols = Array.from(document.querySelectorAll('.ant-row .ant-col')).slice(0, 4)
      .map((c) => Math.round(c.getBoundingClientRect().width))
    return {
      siderWidth: sider ? Math.round(sider.getBoundingClientRect().width) : 0,
      tableColumnCount: cols.length,
      kpiWidths: kpiCols,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })
  ok('PC 侧边栏仍在（220px）', pc.siderWidth === 220, { siderWidth: pc.siderWidth })
  ok('PC 仍是表格且列数完整', pc.tableColumnCount >= 10, { cols: pc.tableColumnCount })
  ok('PC KPI 仍是四列等宽', pc.kpiWidths.length === 4 && new Set(pc.kpiWidths).size === 1, pc.kpiWidths)
  await pp.screenshot({ path: path.join(SHOT_DIR, '14-PC入库页-回归.png') })
  await pctx.close()
} catch (e) {
  out.errors.push(String(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e))
  console.log('FATAL ' + out.errors[out.errors.length - 1])
} finally {
  if (browser) await browser.close()
  const failed = out.checks.filter((c) => !c.pass)
  fs.writeFileSync(path.join(SHOT_DIR, '_e1e2-report.json'), JSON.stringify({ ...out, failedCount: failed.length }, null, 2), 'utf8')
  console.log(`\n== ${out.checks.length - failed.length}/${out.checks.length} 通过 ==`)
}
