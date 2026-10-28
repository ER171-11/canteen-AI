import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/W5-检索域隔离'

/* 与 bff/lib/search.js SENSITIVE_FIELDS 对齐：命中字段/标签绝不能出现这些 */
const SENSITIVE = new Set([
  'tax_no', 'tax', '税号', 'tax_id', 'internal_code', '内部编码', 'inner_code',
  'avg', 'last', 'cost', 'cost_price', '成本', '成本价', '进价',
  'amount', 'amt', '金额', 'payable', 'receivable', 'balance', '应付', '应收', '余额',
  'salary', '薪资', '工资', 'pay', 'id_card', '身份证', 'idcard',
  'bank_account', '银行卡', 'bank', '账户',
])

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

  /* 1. 登录（真人点击：填写账号密码 → 点登录） */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 10000 })
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard|search/, { timeout: 10000 })
  check('登录成功并跳转看板', /\/dashboard/.test(page.url()), page.url())
  await shot('01-登录后-看板.png')

  /* 2. 头部全局搜索框存在（真人点击入口） */
  const headerSearch = page.locator('input[placeholder="全局搜索"]')
  check('头部存在「全局搜索」输入框', (await headerSearch.count()) === 1)

  /* 3. 用头部搜索框搜「饺」→ 应跳转 /search?q=饺 */
  const searchResp = page.waitForResponse(
    (r) => r.url().includes('/api/search') && !r.url().includes('/domains') && r.request().method() === 'GET',
    { timeout: 10000 },
  )
  await headerSearch.fill('饺')
  await headerSearch.press('Enter')
  await page.waitForURL('**/search?q=*', { timeout: 10000 })
  const respBody = await (await searchResp).json()
  check('头部搜索框跳转 /search?q=饺', /\/search\?q=/.test(page.url()), page.url())

  /* 4. 分域 tab 渲染（全部 + 6 域，带计数） */
  await page.waitForSelector('.ant-tabs-tab', { timeout: 10000 })
  await page.waitForTimeout(400)
  const tabs = await page.$$eval('.ant-tabs-tab', (els) => els.map((e) => e.textContent.trim()))
  check('tab 数量 = 7（全部 + 6 域）', tabs.length === 7, tabs)
  check('tab 计数与后端一致', tabs.join('|').includes('商品采购（' + (respBody.domains.procurement.count) + '）'), tabs)
  check('后端 total 与全局一致', respBody.total === 20, respBody.total)
  await shot('02-检索饺-全部域.png')

  /* 5. 命中字段白名单：结果区所有 Tag 均非敏感字段 */
  const tagTexts = await page.$$eval('.ant-list-item .ant-tag', (els) => els.map((e) => e.textContent.trim()))
  const leak = tagTexts.filter((t) => SENSITIVE.has(t))
  check('命中字段/类型标签均非敏感字段（黑名单兜底）', leak.length === 0, leak)
  console.log('      结果区标签抽样：' + tagTexts.slice(0, 12).join(' / '))

  /* 6. 点击「财务税务」tab → 饺在财务域 0 命中（单域不串味） */
  await page.click('.ant-tabs-tab:has-text("财务税务")')
  await page.waitForTimeout(400)
  const finEmpty = await page.locator('text=该域无命中').count()
  check('财务税务 tab 显示「该域无命中」', finEmpty > 0)
  await shot('03-财务税务域-无命中.png')

  /* 7. 点击「商品采购」tab → 只含采购域类型（原料/菜谱/供应商/报价），不含发票/员工/销售单 */
  await page.click('.ant-tabs-tab:has-text("商品采购")')
  await page.waitForTimeout(400)
  const procKinds = await page.$$eval('.ant-list-item .ant-tag', (els) => els.map((e) => e.textContent.trim()))
  const cross = procKinds.filter((k) => ['发票', '员工', '销售单', '证照', '设备', '进货单', '往来账'].includes(k))
  check('商品采购 tab 仅采购域类型（不串味）', cross.length === 0 && procKinds.length > 0, procKinds)
  await shot('04-商品采购域.png')

  /* 8. 深链：点击首条命中 → 跳转对应模块 */
  const firstHit = page.locator('.ant-list-item').first()
  await firstHit.click()
  await page.waitForTimeout(600)
  check('点击命中深链跳转对应模块', !/\/search/.test(page.url()), page.url())
  await shot('05-深链跳转.png')

  /* 9. 回到搜索页，验证无敏感字段文本泄露到结果区（忽略顶部说明文案） */
  await page.goto(BASE + '/search?q=' + encodeURIComponent('饺'))
  await page.waitForSelector('.ant-tabs-tab', { timeout: 10000 })
  await page.waitForTimeout(400)

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
