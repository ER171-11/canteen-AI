import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

/*
 * ADR-013 第 3 批（W3-01 / W3-02 / W3-03）浏览器点击验证
 *   1. 行内「校准」→ 独立弹窗改库存+均价（原因必填）→ 台账写「手工调整」
 *   2. 多选原料 →「批量设置」→ 一次动作改多个安全线
 *   3. 行内「删」→ 有引用被拒并提示「改停用」→ 点「改为停用」→ on:false 且台账保留
 *   4. 行内「删」→ 无引用原料真删
 *
 * 依赖：BFF(8787, 隔离数据目录 + CANTEEN_LOCAL_APPLY=1) + admin-web dev(5173)
 * 用法：node apps/admin-web/w3-stock-calibrate-browser-verify.mjs
 */
const API = 'http://127.0.0.1:8787'
const BASE = 'http://127.0.0.1:5173'
const SHOT_DIR = 'C:/Users/mingyzhikui/Desktop/canteenAI/docs/验收截图/W3-手工校准与批量删除'

const passed = []
const failed = []
function check(name, cond, detail) {
  if (cond) { passed.push(name); console.log('  PASS ' + name) }
  else { failed.push(name); console.log('  FAIL ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail))) }
}

/* ---------- 种子：I1 有流水（禁删）/ I2、I3 可批量 / I9 无引用（可删） ---------- */
const SEED_DATA = {
  rest: '熊猫五福测试餐厅',
  config: {},
  ings: [
    { id: 'I1', name: '面粉', cat: '粮油', unit: '斤', buy: '斤', conv: 1, avg: 5, stock: 10, qty: 10, safe: 1, yld: 1, on: true },
    { id: 'I2', name: '猪肉', cat: '肉类', unit: '斤', buy: '斤', conv: 1, avg: 20, stock: 6, qty: 6, initStock: 6, initAvg: 20, safe: 1, yld: 1, on: true },
    { id: 'I3', name: '青菜', cat: '蔬菜', unit: '斤', buy: '斤', conv: 1, avg: 3, stock: 2, qty: 2, initStock: 2, initAvg: 3, safe: 1, yld: 1, on: true },
    { id: 'I9', name: '误建测试料', cat: '其他', unit: '斤', buy: '斤', conv: 1, avg: 0, stock: 0, qty: 0, safe: 0, yld: 1, on: true }
  ],
  logs: [{ type: '手工调整', ing: 'I1', date: '2026-10-01', qty: 10, inCost: 5, ref: '期初', source: 'seed' }],
  quotes: [], orders: [], recv: [], sales: []
}

async function apiToken() {
  const r = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'boss', password: 'wufu123', device_fp: 'w3-ui-verify' })
  })
  const j = await r.json()
  if (!j || !j.token) throw new Error('API 登录失败: ' + JSON.stringify(j))
  return j.token
}

async function apiGet(token, p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + token } })
  return r.json()
}

async function snapshot(token) {
  const j = await apiGet(token, '/api/snapshot/latest')
  return j.data
}

function ingOf(data, id) {
  return (data.ings || []).find((g) => g && String(g.id) === id) || null
}

fs.mkdirSync(SHOT_DIR, { recursive: true })
let browser, page
const shot = (name) => page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: false })

try {
  /* ---------- 0. 铺种子快照（隔离 BFF） ---------- */
  const token = await apiToken()
  const push = await fetch(API + '/api/snapshot/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ rev: 1, data: SEED_DATA, ext: {}, machine: 'W3-UI-VERIFY' })
  }).then((r) => r.json())
  check('种子快照推送成功（隔离数据目录）', push && push.ok === true, push)

  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error' && !/^Warning:/.test(m.text())) consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => consoleErrors.push(String(e)))

  /* ---------- 1. 登录 ---------- */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 15000 })
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard/, { timeout: 15000 })
  check('登录成功并跳转看板', /\/dashboard/.test(page.url()), page.url())

  /* ---------- 2. W3-01 手工校准（独立弹窗） ---------- */
  await page.goto(BASE + '/inventory/stock', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.ant-table-row', { timeout: 20000 })
  await page.fill('input[placeholder="搜索原料名称…"]', '面粉')
  await page.waitForTimeout(600)
  check('搜索定位到「面粉」', (await page.locator('.ant-table-row').count()) === 1)

  await page.locator('.ant-table-row button:has-text("校准")').first().click()
  await page.waitForSelector('.ant-modal-title:has-text("手工校准")', { timeout: 8000 })
  const modalText = await page.locator('.ant-modal-content').last().textContent()
  check('校准弹窗显示当前库存/均价（与档案编辑分开）', /当前库存/.test(modalText || '') && /当前均价/.test(modalText || ''), modalText)
  await page.waitForTimeout(700) /* 等弹窗动画结束再截图（否则半透明） */
  await shot('01-校准弹窗.png')

  await page.fill('.ant-modal-content input#qty', '12')
  await page.fill('.ant-modal-content input#avg', '7.25')
  await page.fill('.ant-modal-content textarea#note', '浏览器验证：供应商调价核对')
  await page.click('.ant-modal-footer button:has-text("提交校准")')
  await page.waitForSelector('.ant-message-success', { timeout: 15000 })
  await page.waitForTimeout(1200)

  let data = await snapshot(token)
  let i1 = ingOf(data, 'I1')
  check('校准后库存 = 12（数量落账）', i1 && i1.stock === 12, i1 && i1.stock)
  check('校准后均价 = 7.25（均价可单独/一起改）', i1 && i1.avg === 7.25, i1 && i1.avg)
  check('库存总值不为 0（12×7.25=87）', i1 && Math.round(i1.stock * i1.avg * 100) / 100 === 87, i1 && i1.stock * i1.avg)
  const lastLog = data.logs[data.logs.length - 1]
  check('台账新增「手工调整」流水，inCost = 校准均价', lastLog && lastLog.type === '手工调整' && lastLog.inCost === 7.25, lastLog)
  check('流水 note 记录校准原因', lastLog && /浏览器验证/.test(String(lastLog.note)), lastLog && lastLog.note)

  /* ---------- 3. W3-02 批量设置安全线 ---------- */
  await page.fill('input[placeholder="搜索原料名称…"]', '')
  await page.waitForTimeout(600)
  const rowCount = await page.locator('.ant-table-row').count()
  check('清空搜索恢复列表', rowCount >= 4, rowCount)

  const batchBtnDisabledBefore = await page.locator('button:has-text("批量设置")').first().isDisabled()
  check('未勾选时「批量设置」禁用', batchBtnDisabledBefore === true)

  await page.locator('.ant-table-row').nth(0).locator('input[type="checkbox"]').check()
  await page.locator('.ant-table-row').nth(1).locator('input[type="checkbox"]').check()
  await page.waitForTimeout(300)
  const batchBtn = page.locator('button:has-text("批量设置（2）")').first()
  check('勾选 2 个原料后按钮显示计数并启用', (await batchBtn.count()) === 1 && !(await batchBtn.isDisabled()))
  await page.waitForTimeout(300)
  await shot('02-多选批量设置.png')

  await batchBtn.click()
  await page.waitForSelector('.ant-modal-title:has-text("批量设置")', { timeout: 8000 })
  await page.fill('.ant-modal-content input#safe', '8')
  await page.click('.ant-modal-footer button:has-text("批量提交")')
  await page.waitForSelector('.ant-message-success', { timeout: 15000 })
  await page.waitForTimeout(1200)

  data = await snapshot(token)
  const safeOf = (id) => (ingOf(data, id) || {}).safe
  check('批量设置只改勾选的 2 个原料安全线 = 8', safeOf('I1') === 8 && safeOf('I2') === 8, [safeOf('I1'), safeOf('I2'), safeOf('I3')])
  check('未勾选原料安全线不变', safeOf('I3') === 1, safeOf('I3'))
  check('批量改主数据不碰存量（I1 数量/均价不变）',
    ingOf(data, 'I1').stock === 12 && ingOf(data, 'I1').avg === 7.25,
    [ingOf(data, 'I1').stock, ingOf(data, 'I1').avg])

  /* ---------- 4. W3-03 删除有引用原料 → 被拒 → 改停用 ---------- */
  await page.fill('input[placeholder="搜索原料名称…"]', '面粉')
  await page.waitForTimeout(600)
  await page.locator('.ant-table-row button:has-text("删")').first().click()
  /* antd 会在两个汉字间插空格（「删 除」），故按 Popconfirm 主按钮定位 */
  await page.locator('.ant-popconfirm-buttons button.ant-btn-primary').first().click()
  await page.waitForSelector('.ant-modal-confirm', { timeout: 15000 })
  const confirmText = await page.locator('.ant-modal-confirm').textContent()
  check('有引用（库存流水）原料删除被拒', /该原料不能删除/.test(confirmText || ''), confirmText)
  check('拒绝原因写明引用来源并提示「停用」',
    /库存流水/.test(confirmText || '') && /停用/.test(confirmText || ''), confirmText)
  await page.waitForTimeout(700) /* 等确认框动画结束 + Popconfirm 收起 */
  await shot('03-删除被拒改停用.png')

  await page.locator('.ant-modal-confirm-btns button:has-text("改为停用")').click()
  await page.waitForSelector('.ant-message-success', { timeout: 15000 })
  await page.waitForTimeout(1200)
  data = await snapshot(token)
  check('点「改为停用」后 on=false（不物理删）', ingOf(data, 'I1') && ingOf(data, 'I1').on === false, ingOf(data, 'I1') && ingOf(data, 'I1').on)
  check('停用后台账流水仍在（红线 #6）', (data.logs || []).some((l) => l && l.ing === 'I1'))

  /* ---------- 5. W3-03 删除无引用原料 → 真删 ---------- */
  await page.fill('input[placeholder="搜索原料名称…"]', '误建测试料')
  await page.waitForTimeout(600)
  await page.locator('.ant-table-row button:has-text("删")').first().click()
  await page.locator('.ant-popconfirm-buttons button.ant-btn-primary').first().click()
  await page.waitForSelector('.ant-message-success', { timeout: 15000 })
  await page.waitForTimeout(1200)
  data = await snapshot(token)
  check('无引用原料被真删（data.ings 移除 I9）', !ingOf(data, 'I9'), (data.ings || []).map((g) => g.id))

  check('页面无 JS 运行错误', consoleErrors.length === 0, consoleErrors.slice(0, 3))

  console.log('')
  console.log('== ADR-013 第 3 批浏览器验证：' + passed.length + ' 通过 / ' + failed.length + ' 失败 ==')
  console.log('   截图目录: ' + SHOT_DIR)
  if (failed.length) process.exitCode = 1
} catch (e) {
  console.log('!! 验证中断: ' + (e && e.message ? e.message : e))
  process.exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
}
