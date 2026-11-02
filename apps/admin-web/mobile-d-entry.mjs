/*
 * mobile-d-entry.mjs — 验证「手机版入口」不再落到 /m 空壳
 *
 * 覆盖两处入口：
 *   1) 登录页 →「手机版入口 · 店长（进销存 → 入库单）」
 *   2) 顶栏  →「手机版」按钮
 * 两者都应落到 /inventory/inbound 且能看到真实单据（.ant-table 有数据行）。
 * 只读：不点任何写操作。
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/D-手机浏览器兜底'
const out = { checks: [], errors: [] }
fs.mkdirSync(SHOT_DIR, { recursive: true })

let browser
try {
  browser = await chromium.launch({ headless: true })

  /* ---------- 入口 1：登录页按钮（手机视口） ---------- */
  const mobileCtx = await browser.newContext({ ...devices['iPhone 13'] })
  const p1 = await mobileCtx.newPage()
  p1.on('pageerror', (e) => out.errors.push(String(e)))
  await p1.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p1.waitForSelector('text=手机版入口 · 店长', { timeout: 15000 })
  const entryText = await p1.locator('button:has-text("手机版入口")').innerText()
  await p1.click('button:has-text("手机版入口")')
  await p1.waitForURL('**/inventory/inbound', { timeout: 20000 })
  await p1.waitForSelector('.ant-table', { timeout: 20000 })
  await p1.waitForTimeout(1200)
  const rowCount = await p1.locator('.ant-table-tbody tr.ant-table-row').count()
  const isShell = await p1.locator('text=打开桌面版完整页').count()
  await p1.screenshot({ path: path.join(SHOT_DIR, '10-手机版入口-登录后落点.png') })
  out.checks.push({
    name: '登录页「手机版入口」落点',
    buttonText: entryText.trim(),
    url: p1.url(),
    landedOnInbound: /\/inventory\/inbound/.test(p1.url()),
    tableRows: rowCount,
    stillPreviewShell: isShell > 0,
  })
  await mobileCtx.close()

  /* ---------- 入口 2：顶栏「手机版」（PC 视口，顶栏在窄屏可能被收起） ---------- */
  const pcCtx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const p2 = await pcCtx.newPage()
  p2.on('pageerror', (e) => out.errors.push(String(e)))
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p2.waitForSelector('input[placeholder="岗位账号"]', { timeout: 15000 })
  await p2.fill('input[placeholder="岗位账号"]', 'boss')
  await p2.fill('input[placeholder="密码"]', 'wufu123')
  await p2.click('button:has-text("登 录")')
  await p2.waitForURL(/dashboard/, { timeout: 20000 })
  await p2.waitForTimeout(800)
  const topBtn = p2.locator('button:has-text("手机版")').first()
  const topBtnVisible = (await topBtn.count()) > 0
  if (topBtnVisible) {
    await topBtn.click()
    await p2.waitForTimeout(1500)
  }
  out.checks.push({
    name: '顶栏「手机版」落点',
    buttonFound: topBtnVisible,
    url: p2.url(),
    landedOnInbound: /\/inventory\/inbound/.test(p2.url()),
    urlStillShell: /\/m(\/|$|\?)/.test(p2.url()),
  })
  await p2.screenshot({ path: path.join(SHOT_DIR, '11-顶栏手机版-落点.png') })
  await pcCtx.close()
} catch (e) {
  out.errors.push(String(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e))
} finally {
  if (browser) await browser.close()
  fs.writeFileSync(path.join(SHOT_DIR, '_entry-report.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log(JSON.stringify(out, null, 2))
}
