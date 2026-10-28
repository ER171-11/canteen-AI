import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

/*
 * W3 产品超链接浏览器真人点击验证
 *   - 供应商资质证照超链接（VendorsPage 资质列 <a>）
 *   - 原料详情质检报告超链接（StockPage 展开详情「查看报告」<a>）
 * 依赖：admin-web dev(5173) + BFF(8787, sandbox) 均在跑；演示数据已注入 snapshot.json。
 */
const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/W3-产品超链接'

const VENDOR_CERT_URL = 'https://img.example.com/certs/测试供应商-yyzz.pdf'
const QC_REPORT_URL = 'https://img.example.com/qc/I1-report.pdf'

const passed = []
const failed = []
function check(name, cond, detail) {
  if (cond) { passed.push(name); console.log('  PASS ' + name) }
  else { failed.push(name); console.log('  FAIL ' + name + (detail ? '  → ' + JSON.stringify(detail) : '')) }
}

fs.mkdirSync(SHOT_DIR, { recursive: true })
const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false })

let browser, page
try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Warning:/.test(m.text())) consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  /* ============ 1. 登录（真人点击） ============ */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 10000 })
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard|search/, { timeout: 10000 })
  check('登录成功并跳转看板', /\/dashboard/.test(page.url()), page.url())

  /* ============ 2. 供应商资质超链接（真人点击） ============ */
  await page.goto(BASE + '/inventory/vendors', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ant-table-row', { timeout: 15000 })
  await page.waitForTimeout(600)

  // 收集所有 target=_blank 的证照链接，取 href 命中的那个
  const certLinks = await page.$$eval('a[target="_blank"]', (els) =>
    els.map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') })).filter((x) => x.href),
  )
  const hit = certLinks.filter((x) => (x.href || '').indexOf('测试供应商-yyzz.pdf') >= 0)
  check('供应商资质列出现证照附件链接', hit.length >= 1, hit.map((h) => h.text))
  check('证照链接 href = 注入 URL', hit.some((h) => h.href === VENDOR_CERT_URL), hit.map((h) => h.href))
  check('证照链接文字为资质类型（检验合格/营业执照）', hit.some((h) => /检验合格|营业执照/.test(h.text)), hit.map((h) => h.text))
  await shot('01-供应商资质-证照链接.png')

  // 真人点击证照链接 → 应触发 target=_blank 打开新窗口（即链接确实可点）
  if (hit.length) {
    const popupPromise = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null)
    await page.locator(`a[href="${VENDOR_CERT_URL}"]`).first().click()
    const popup = await popupPromise
    check('点击证照链接打开新窗口（target=_blank 生效）', !!popup)
    if (popup) await popup.close().catch(() => {})
  } else {
    check('点击证照链接打开新窗口（target=_blank 生效）', false, '无可用链接')
  }

  /* ============ 3. 原料详情质检报告超链接（真人点击） ============ */
  await page.goto(BASE + '/inventory/stock', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ant-table-row', { timeout: 15000 })

  // 搜索框过滤到目标原料（真人输入）
  await page.fill('input[placeholder="搜索原料名称…"]', '东古一品鲜')
  await page.waitForTimeout(600)
  const firstRowName = await page.$$eval('.ant-table-row', (els) => els.map((e) => e.textContent || '')).then((a) => a.filter((t) => /东古一品鲜/.test(t)))
  check('搜索过滤定位到「东古一品鲜500ml」', firstRowName.length === 1, firstRowName)

  // 真人点击行首 ▸ 展开详情
  const expandIcon = page.locator('.ant-table-row .ant-table-row-expand-icon').first()
  await expandIcon.click()
  await page.waitForSelector('text=质检报告', { timeout: 5000 })
  await page.waitForTimeout(300)

  // 详情里「质检报告」的「查看报告」链接
  const qcLink = page.locator('a[target="_blank"]', { hasText: '查看报告' }).first()
  const qcCount = await qcLink.count()
  check('原料详情出现「质检报告 → 查看报告」链接', qcCount === 1, 'count=' + qcCount)
  if (qcCount) {
    const qcHref = await qcLink.getAttribute('href')
    check('质检报告链接 href = 注入 URL', qcHref === QC_REPORT_URL, qcHref)
  } else {
    check('质检报告链接 href = 注入 URL', false, '无链接')
  }
  await shot('02-原料详情-质检报告.png')

  // 真人点击「查看报告」→ target=_blank 新窗口
  const qcPopupPromise = page.waitForEvent('popup', { timeout: 4000 }).catch(() => null)
  if (qcCount) await qcLink.click()
  const qcPopup = await qcPopupPromise
  check('点击质检报告链接打开新窗口（target=_blank 生效）', !!qcPopup)
  if (qcPopup) await qcPopup.close().catch(() => {})

  /* ============ 4. 无页面级 JS 报错 ============ */
  check('无页面级 JS 报错', consoleErrors.length === 0, consoleErrors.slice(0, 3))

  console.log('\n========== 汇总 ==========')
  console.log('通过 ' + passed.length + ' 项；失败 ' + failed.length + ' 项')
  console.log('截图目录：' + SHOT_DIR)
} catch (e) {
  console.error('脚本异常：', e && e.message)
  if (failed.length === 0) failed.push('脚本异常: ' + (e && e.message))
} finally {
  if (page) { try { await page.close() } catch {} }
  if (browser) { try { await browser.close() } catch {} }
}

if (failed.length) process.exit(1)
