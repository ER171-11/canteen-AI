/*
 * mobile-d-export.mjs — D 方案最后一公里实测：手机上「出结算单 → 导出 PDF」是否真的落文件
 *
 * 只读：结算单是只读输出层，导出不写库。绝不点「确认入库」等写操作。
 * 用法：node mobile-d-export.mjs
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/D-手机浏览器兜底'
/* 账号可传参：node mobile-d-export.mjs manager */
const ACCOUNT = process.argv[2] || 'boss'
const out = { account: ACCOUNT, downloads: [], popups: 0, landscape: {}, errors: [] }
fs.mkdirSync(SHOT_DIR, { recursive: true })

let browser
try {
  browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(String(e)))

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 15000 })
  await page.fill('input[placeholder="岗位账号"]', ACCOUNT)
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard/, { timeout: 15000 })

  await page.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=进货入库', { timeout: 20000 })
  await page.waitForTimeout(1000)

  // 打开单张结算单
  await page.getByRole('button', { name: '结算单', exact: true }).first().click()
  await page.waitForTimeout(800)

  /* --- 1. 点「导出 PDF（微信可传）」看是否真的产出文件 --- */
  const dlPromise = page.waitForEvent('download', { timeout: 12000 }).catch(() => null)
  await page.getByRole('button', { name: /导出 PDF/ }).first().click()
  const dl = await dlPromise
  if (dl) {
    const suggested = dl.suggestedFilename()
    const saveTo = path.join(SHOT_DIR, suggested)
    await dl.saveAs(saveTo).catch(() => {})
    const st = fs.existsSync(saveTo) ? fs.statSync(saveTo) : null
    out.downloads.push({ kind: 'PDF', suggested, bytes: st ? st.size : null, saved: saveTo })
  } else {
    out.downloads.push({ kind: 'PDF', triggered: false, note: '未捕获 download 事件' })
  }
  await page.waitForTimeout(600)
  await page.screenshot({ path: path.join(SHOT_DIR, '06-导出PDF后.png') })

  /* --- 2. 导出电子版（HTML）：可能新窗口或下载 --- */
  const popupPromise = page.waitForEvent('popup', { timeout: 6000 }).catch(() => null)
  const dl2Promise = page.waitForEvent('download', { timeout: 6000 }).catch(() => null)
  const htmlBtn = page.getByRole('button', { name: /导出电子版/ }).first()
  if (await htmlBtn.count() > 0) {
    await htmlBtn.click()
    const popup = await popupPromise
    const dl2 = await dl2Promise
    if (popup) { out.popups += 1; await popup.close() }
    out.downloads.push({ kind: 'HTML', popup: !!popup, download: dl2 ? dl2.suggestedFilename() : null })
  }

  /* --- 3. 横屏（844×390）是否比竖屏好 --- */
  await page.keyboard.press('Escape').catch(() => {})
  await page.setViewportSize({ width: 844, height: 390 })
  await page.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  const land = await page.evaluate(() => {
    const de = document.documentElement
    const sider = document.querySelector('.ant-layout-sider')
    const t = document.querySelector('.ant-table-content')
    return {
      innerWidth: window.innerWidth,
      docScrollWidth: de.scrollWidth,
      horizontalOverflow: de.scrollWidth > window.innerWidth + 1,
      siderWidth: sider ? Math.round(sider.getBoundingClientRect().width) : 0,
      tableScrollWidth: t ? Math.round(t.scrollWidth) : null,
      tableClientWidth: t ? Math.round(t.clientWidth) : null,
    }
  })
  out.landscape = land
  await page.screenshot({ path: path.join(SHOT_DIR, '07-横屏入库页.png') })
} catch (e) {
  out.errors.push(String(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e))
} finally {
  if (browser) await browser.close()
  fs.writeFileSync(path.join(SHOT_DIR, '_export-report.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log(JSON.stringify(out, null, 2))
}
