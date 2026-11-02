/*
 * mobile-d-check.mjs — D 方案实测：手机浏览器（375×812）直开 PC 版「入库」页
 *
 * 只读：只做 GET 与「打开弹窗」，绝不点「确认入库」「新建进货单」等写操作。
 * 产出：docs/验收截图/D-手机浏览器兜底/*.png + 控制台 JSON 报告
 *
 * 用法：node mobile-d-check.mjs
 * 前置：BFF(8787) + admin-web(5173) 已启动
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/D-手机浏览器兜底'
const report = { viewport: null, checks: [], flow: [], fatal: null }

fs.mkdirSync(SHOT_DIR, { recursive: true })

let browser, page
try {
  browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ ...devices['iPhone 13'] }) // 390×844 DPR3，最接近客户机
  page = await ctx.newPage()
  report.viewport = page.viewportSize()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false })

  /* ---------- 1. 登录 ---------- */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 15000 })
  await shot('01-登录页-手机.png')
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard|search/, { timeout: 15000 })
  report.flow.push('登录成功 → ' + page.url())

  /* ---------- 2. 进销 → 入库 ---------- */
  await page.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  // 移动端走卡片列表（不再有 .ant-table），等业务标题出现即可
  await page.waitForSelector('text=进货入库', { timeout: 20000 })
  await page.waitForTimeout(1200)
  await shot('02-入库页-首屏.png')

  /* 视口/溢出度量 */
  const metrics = await page.evaluate(() => {
    const vw = window.innerWidth
    const de = document.documentElement
    const table = document.querySelector('.ant-table-content') || document.querySelector('.ant-table')
    const sider = document.querySelector('.ant-layout-sider')
    const header = document.querySelector('.ant-layout-header')
    const btns = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.offsetParent !== null)
      .map((b) => {
        const r = b.getBoundingClientRect()
        return {
          text: (b.textContent || '').trim().slice(0, 10),
          left: Math.round(r.left), right: Math.round(r.right),
          top: Math.round(r.top),
          inViewportX: r.left >= 0 && r.right <= vw,
        }
      })
    return {
      innerWidth: vw,
      docScrollWidth: de.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      horizontalOverflow: de.scrollWidth > vw + 1,
      siderWidth: sider ? Math.round(sider.getBoundingClientRect().width) : 0,
      siderVisible: !!sider && sider.offsetParent !== null,
      headerWidth: header ? Math.round(header.getBoundingClientRect().width) : 0,
      tableScrollWidth: table ? Math.round(table.scrollWidth) : null,
      tableClientWidth: table ? Math.round(table.clientWidth) : null,
      visibleButtons: btns,
      offscreenButtons: btns.filter((b) => !b.inViewportX).map((b) => b.text),
    }
  })
  report.checks.push({ name: '入库页布局度量', ...metrics })

  /* ---------- 3. 行内「结算单」是否点得到 ---------- */
  // 精确匹配「结算单」，避免命中顶部的「批量结算单」
  const settleBtn = page.getByRole('button', { name: '结算单', exact: true }).first()
  const settleCount = await page.getByRole('button', { name: '结算单', exact: true }).count()
  report.checks.push({ name: '行内「结算单」按钮数量', value: settleCount })
  if (settleCount > 0) {
    await settleBtn.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await shot('03-滚动到行内结算单.png')
    await settleBtn.click()
    await page.waitForTimeout(900)
    await shot('04-结算单弹窗.png')
    const modal = await page.evaluate(() => {
      const m = document.querySelector('.ant-modal')
      if (!m) return null
      const r = m.getBoundingClientRect()
      const body = document.querySelector('.ant-modal-body')
      return {
        left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
        inViewportX: r.left >= 0 && r.right <= window.innerWidth,
        overflowX: Math.round(r.width - window.innerWidth),
        bodyScrollWidth: body ? Math.round(body.scrollWidth) : null,
        bodyClientWidth: body ? Math.round(body.clientWidth) : null,
        bodyOverflow: body ? body.scrollWidth > body.clientWidth + 1 : null,
        buttons: Array.from(m.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean),
        textSample: (m.textContent || '').replace(/\s+/g, ' ').slice(0, 400),
      }
    })
    report.checks.push({ name: '结算单弹窗度量', ...modal })
    // 关掉弹窗
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  } else {
    report.checks.push({ name: '行内「结算单」按钮', value: '未找到（可能当前筛选无单据）' })
  }

  /* ---------- 4. 批量结算单入口 ---------- */
  const batchBtn = page.locator('button:has-text("批量结算单")').first()
  if (await batchBtn.count() > 0) {
    await batchBtn.scrollIntoViewIfNeeded()
    const box = await batchBtn.boundingBox()
    report.checks.push({ name: '「批量结算单」按钮位置', box })
    await batchBtn.click({ trial: false }).catch(() => {})
    await page.waitForTimeout(900)
    await shot('05-批量结算单弹窗.png')
    const batch = await page.evaluate(() => {
      const m = document.querySelector('.ant-modal')
      if (!m) return null
      const r = m.getBoundingClientRect()
      return {
        width: Math.round(r.width), inViewportX: r.left >= 0 && r.right <= window.innerWidth,
        buttons: Array.from(m.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean),
      }
    })
    report.checks.push({ name: '批量结算单弹窗度量', ...batch })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(400)
  }

  /* ---------- 5. 顶部工具栏是否换行/溢出 ---------- */
  const toolbar = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'))
      .filter((b) => b.offsetParent !== null && /批量结算单|批量导入|新建进货单|下载导入模板|导出/.test(b.textContent || ''))
      .map((b) => {
        const r = b.getBoundingClientRect()
        return { text: (b.textContent || '').trim(), top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) }
      })
    return btns
  })
  report.checks.push({ name: '顶部工具栏按钮分布', toolbar })

  report.checks.push({ name: '控制台错误条数', value: consoleErrors.length, sample: consoleErrors.slice(0, 5) })
} catch (e) {
  report.fatal = String(e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e)
} finally {
  if (browser) await browser.close()
  fs.writeFileSync(path.join(SHOT_DIR, '_report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(JSON.stringify(report, null, 2))
}
