/*
 * mobile-d-inbound.mjs — D 方案前置动作实测：手机上「新建进货单」「批量导入」弹窗能否填写
 *
 * 只打开弹窗测量，绝不提交（不点确定/提交，直接 Escape 关闭）。零写库。
 * 用法：node mobile-d-inbound.mjs
 */
import { chromium, devices } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/D-手机浏览器兜底'
const out = { modals: [], errors: [] }
fs.mkdirSync(SHOT_DIR, { recursive: true })

async function measureModal(page, label, shotName) {
  await page.waitForTimeout(900)
  const m = await page.evaluate(() => {
    const el = document.querySelector('.ant-modal')
    if (!el) return null
    const r = el.getBoundingClientRect()
    const body = el.querySelector('.ant-modal-body')
    // 统计可见输入控件，并找出被裁到视口外的
    const ctrls = Array.from(el.querySelectorAll('input, textarea, .ant-select, button'))
      .filter((c) => c.offsetParent !== null)
      .map((c) => {
        const b = c.getBoundingClientRect()
        return {
          tag: c.tagName.toLowerCase(),
          text: (c.textContent || c.getAttribute('placeholder') || '').trim().slice(0, 12),
          right: Math.round(b.right),
          clipped: b.right > window.innerWidth + 1,
        }
      })
    return {
      width: Math.round(r.width),
      right: Math.round(r.right),
      innerWidth: window.innerWidth,
      inViewportX: r.left >= 0 && r.right <= window.innerWidth + 1,
      bodyOverflowX: body ? body.scrollWidth > body.clientWidth + 1 : null,
      controlCount: ctrls.length,
      clippedControls: ctrls.filter((c) => c.clipped).map((c) => c.text),
      footerButtons: Array.from(el.querySelectorAll('.ant-modal-footer button')).map((b) => (b.textContent || '').trim()),
      textSample: (el.textContent || '').replace(/\s+/g, ' ').slice(0, 260),
    }
  })
  await page.screenshot({ path: path.join(SHOT_DIR, shotName) })
  out.modals.push({ label, ...(m || { note: '未找到弹窗' }) })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

let browser
try {
  browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => out.errors.push(String(e)))

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 15000 })
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard/, { timeout: 15000 })

  await page.goto(BASE + '/inventory/inbound', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('text=进货入库', { timeout: 20000 })
  await page.waitForTimeout(1000)

  /* 1. 新建进货单 */
  const newBtn = page.getByRole('button', { name: /新建进货单/ }).first()
  if (await newBtn.count() > 0) {
    await newBtn.click()
    await measureModal(page, '新建进货单', '08-新建进货单弹窗.png')
  } else {
    out.modals.push({ label: '新建进货单', note: '按钮未找到（可能无写权限）' })
  }

  /* 2. 批量导入 */
  const impBtn = page.getByRole('button', { name: /批量导入/ }).first()
  if (await impBtn.count() > 0 && await impBtn.isEnabled()) {
    await impBtn.click()
    await measureModal(page, '批量导入', '09-批量导入弹窗.png')
  } else {
    out.modals.push({ label: '批量导入', note: '按钮不可用（只读角色或演练模式）' })
  }
} catch (e) {
  out.errors.push(String(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e))
} finally {
  if (browser) await browser.close()
  fs.writeFileSync(path.join(SHOT_DIR, '_inbound-report.json'), JSON.stringify(out, null, 2), 'utf8')
  console.log(JSON.stringify(out, null, 2))
}
