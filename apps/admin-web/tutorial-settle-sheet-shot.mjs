import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

/*
 * 截「结算单成品」：从入库单行内结算单 → 导出电子版(HTML) → 用浏览器打开该文件截图。
 * 这样教程里能直接看到打出来的那张纸长什么样（不依赖 PDF 渲染器）。
 */
const BASE = 'http://127.0.0.1:5173'
const ROOT = 'C:/Users/mingyzhikui/Desktop/canteenAI'
const OUT = path.join(ROOT, 'docs/教程-入库单导入到结算单/截图')
const TMP = path.join(ROOT, '.tmp-tutorial/fixtures')
fs.mkdirSync(TMP, { recursive: true })

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]')
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForTimeout(2500)
  await page.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ant-table-row', { timeout: 20000 })
  await page.waitForTimeout(800)

  const row = page.locator('.ant-table-tbody tr.ant-table-row').first()
  const no = (await row.locator('td').nth(1).innerText()).trim()
  await row.locator('button:has-text("结算单")').first().click()
  await page.locator('.ant-modal-content:visible').last().waitFor({ state: 'visible' })
  await page.waitForTimeout(600)

  const dl = page.waitForEvent('download', { timeout: 20000 })
  await page.locator('.ant-modal-footer button:has-text("导出电子版")').click()
  const d = await dl
  const htmlPath = path.join(TMP, await d.suggestedFilename())
  await d.saveAs(htmlPath)
  console.log('结算单 HTML = ' + htmlPath)

  const sheet = await browser.newPage({ viewport: { width: 1000, height: 1300 } })
  await sheet.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' })
  await sheet.waitForTimeout(500)
  const el = sheet.locator('.sheet').first()
  await el.waitFor({ state: 'visible' })
  await el.screenshot({ path: path.join(OUT, '15-结算单成品.png') })
  console.log('  ✓ 15-结算单成品.png（来源单号 ' + no + '）')
} catch (e) {
  console.error('失败：', e)
  process.exitCode = 1
} finally {
  await browser.close()
}
