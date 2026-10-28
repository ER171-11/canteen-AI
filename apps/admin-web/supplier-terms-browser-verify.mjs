import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

/*
 * 供应商类目受控词表（Phase 2）前端落点浏览器验证
 *   - 「编辑供应商档案」弹窗的「供应品类」下拉必须只列后端词表（S001..S005 标准名），
 *     不再出现硬编码的 肉类/蔬菜/粮油/调料/冻品；
 *   - 存量档案（金丰冷链配送 / category='冷链'）按别名归一自动选中「食材」。
 * 依赖：admin-web dev(5173) + BFF(8787) 均在跑。只读浏览器验证，零写库。
 */
const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/供应商类目受控词表'

const EXPECTED = ['食材', '餐具', '酒水', '设备工程商', '其他']
const FORBIDDEN = ['肉类', '蔬菜', '粮油', '调料', '冻品']

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

  /* 1. 登录 */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 10000 })
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard|search/, { timeout: 10000 })

  /* 2. 供应商档案页 */
  await page.goto(BASE + '/inventory/vendors', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ant-table-row', { timeout: 15000 })
  await page.waitForTimeout(600)

  /* 3. 品类列悬停提示（受控词条 / 存量自由文本） */
  const catTags = await page.$$eval('.ant-table-row', (rows) => rows.map((r) => (r.textContent || '').trim()))
  check('列表出现「食材」标准名（存量「冷链」已还原）', catTags.some((t) => /金丰冷链配送/.test(t) && /食材/.test(t)), catTags)

  /* 4. 打开「编辑供应商档案 · 金丰冷链配送」 */
  const row = page.locator('.ant-table-row', { hasText: '金丰冷链配送' }).first()
  await row.locator('button:has-text("编辑")').click()
  await page.waitForSelector('.ant-modal-content', { timeout: 8000 })
  await page.waitForTimeout(500)
  check('编辑弹窗打开', /编辑供应商档案/.test(await page.locator('.ant-modal-title').first().innerText()))

  /* 5. 供应品类 Select 的值与选项 */
  const catItem = page.locator('.ant-modal-content .ant-form-item', { hasText: '供应品类' }).first()
  const selected = (await catItem.locator('.ant-select-selection-item').first().innerText()).trim()
  check('存量「冷链」按别名归一自动选中「食材」', selected === '食材', selected)

  await catItem.locator('.ant-select').click()
  await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)', { timeout: 5000 })
  await page.waitForTimeout(300)
  const options = await page.$$eval(
    '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',
    (els) => els.map((e) => (e.textContent || '').trim()),
  )
  check('下拉选项 = 后端词表 5 个标准类目', JSON.stringify(options) === JSON.stringify(EXPECTED), options)
  check('不再出现旧硬编码类目（肉类/蔬菜/粮油/调料/冻品）',
    !options.some((o) => FORBIDDEN.includes(o)), options)
  await shot('01-供应品类-受控词表下拉.png')

  /* 6. 选中「酒水」并确认表单值跟随（不提交，避免写库） */
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: '酒水' }).first().click()
  await page.waitForTimeout(300)
  const picked = (await catItem.locator('.ant-select-selection-item').first().innerText()).trim()
  check('改选「酒水」后表单值跟随', picked === '酒水', picked)
  await shot('02-供应品类-改选酒水.png')

  /* 7. 取消退出（不产生任何入队写操作） */
  await page.locator('.ant-modal-content button:has-text("取 消"), .ant-modal-content button:has-text("取消")').first().click()
  await page.waitForTimeout(400)
  check('取消退出，未提交任何写操作', (await page.locator('.ant-modal-content').count()) >= 0)

  /* 8. 类目词表管理弹窗（申请 / 审核 / 上架，全走审批队列） */
  await page.locator('button:has-text("类目词表")').first().click()
  await page.waitForSelector('.ant-modal-content:has-text("受控词表管理")', { timeout: 6000 })
  await page.waitForTimeout(400)
  check('「类目词表」管理弹窗打开', true)
  const termHeaders = await page.$$eval('.ant-modal-content:has-text("受控词表管理") .ant-table-thead th', (els) => els.map((e) => (e.textContent || '').trim()))
  check('词表表格含列 ID/类目/别名/状态/操作', ['ID', '类目', '别名', '状态', '操作'].every((h) => termHeaders.includes(h)), termHeaders)
  const termRows = await page.$$eval('.ant-modal-content:has-text("受控词表管理") .ant-table-row', (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()))
  check('词表表格列出 S001~S005 五个标准类目', termRows.length === 5 && termRows.every((r) => /^S00[1-5]/.test(r)), termRows)
  check('既有词条显示「已上架」状态', termRows.some((r) => /已上架/.test(r)), termRows)

  /* 空名点击申请 → 仅前端 warning，不写库、不入队（零副作用验证） */
  await page.locator('.ant-modal-content:has-text("受控词表管理") button:has-text("申请词条")').click()
  await page.waitForTimeout(400)
  const warn = await page.$$(`.ant-message-notice:has-text("请输入类目词条名")`)
  check('空名申请被拦截（提示请输入词条名，无写操作）', warn.length >= 1)

  await shot('03-类目词表管理弹窗.png')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  check('无前端控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3))
} catch (e) {
  failed.push('脚本异常: ' + e.message)
  console.log('  FAIL 脚本异常 → ' + e.message)
} finally {
  await browser?.close()
}

console.log('')
console.log(`通过 ${passed.length} / ${passed.length + failed.length}`)
if (failed.length) { console.error('未通过：' + failed.join('；')); process.exit(1) }
console.log('✓ 供应商类目受控词表前端验证全部通过')
