import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

/*
 * 图文教程截图生成器（入库单外部导入 → 结算单）
 *
 * 用法：
 *   1) BFF：BFF_DATA_DIR=<沙箱目录> CANTEEN_LOCAL_APPLY=1 node bff/server.js   （8787）
 *      —— CANTEEN_LOCAL_APPLY=1 是桌面端「无店内消费器」模式：确认后由 BFF 直接落快照，
 *         否则动作停在「待执行」，列表不会出现新单（截图会失败）。
 *   2) 前端：cd apps/admin-web && npm run dev                                （5173）
 *   3) node apps/admin-web/tutorial-recv-import-shots.mjs
 *
 * 产出：docs/教程-入库单导入到结算单/截图/*.png（红框 + 序号标注）
 * 说明：标注不是后期 P 图 —— 取真实控件 getBoundingClientRect 后在页面内注入覆盖层再截图。
 */

const BASE = 'http://127.0.0.1:5173'
const ROOT = 'C:/Users/mingyzhikui/Desktop/canteenAI'
const OUT = path.join(ROOT, 'docs/教程-入库单导入到结算单/截图')
const CSV_GOOD = path.join(ROOT, 'docs/测试与验收/样例数据/入库单导入样例_单供应商_20261030.csv')
const TMP = path.join(ROOT, '.tmp-tutorial/fixtures')

fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(TMP, { recursive: true })

const FAKE_XLS = path.join(TMP, '供应商送货单.xls')
if (!fs.existsSync(FAKE_XLS)) {
  const head = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  fs.writeFileSync(FAKE_XLS, Buffer.concat([head, Buffer.alloc(4096, 0)]))
}
const BAD_HEADER = path.join(TMP, '列名古怪的送货单.csv')
fs.writeFileSync(BAD_HEADER, '\ufeff货名,件数,单价\n土豆,8,2.50\n大白菜,10,3.20\n', 'utf8')

let browser
let page
const shots = []

const modal = () => page.locator('.ant-modal-content:visible').last()

/** 表头文字 → 列序号（expand 列会让 th/td 序号整体右移，统一按表头算） */
async function cellIdx(header) {
  const ths = page.locator('.ant-table-thead th')
  const n = await ths.count()
  for (let i = 0; i < n; i++) {
    const t = (await ths.nth(i).innerText()).trim()
    if (t === header) return i
  }
  return -1
}

/**
 * 标注 + 截图：滚动复位 → 取 rect → 画红框/序号 → 截图（单次 evaluate，避免多轮往返拖时间）
 * marks: {num, css, text?, last?} | {num, row, td} | {num, row, btn}
 */
async function shot(name, marks = []) {
  const log = await page.evaluate((list) => {
    window.scrollTo(0, 0)
    for (const s of ['.ant-table-content', '.ant-table-body']) {
      const el = document.querySelector(s)
      if (el) el.scrollLeft = 0
    }
    const rows = document.querySelectorAll('.ant-table-tbody tr.ant-table-row')
    const boxOf = (el) => {
      const b = el.getBoundingClientRect()
      return b.width > 1 && b.height > 1 ? b : null
    }
    const pick = (m) => {
      if (m.row != null) {
        const r = rows[m.row]
        if (!r) return null
        if (m.td != null) return r.querySelectorAll('td')[m.td] || null
        if (m.btn) return [...r.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === m.btn) || null
        return r
      }
      let els = [...document.querySelectorAll(m.css)]
      if (m.text) els = els.filter((e) => (e.textContent || '').includes(m.text))
      els = els.filter((e) => boxOf(e))
      if (!els.length) return null
      /* smallest：文本过滤常同时命中外层容器（整块 modal body），取面积最小的那个才是真正那一行 */
      if (m.smallest) {
        els.sort((a, b) => {
          const ra = a.getBoundingClientRect()
          const rb = b.getBoundingClientRect()
          return ra.width * ra.height - rb.width * rb.height
        })
        return els[0]
      }
      return m.last ? els[els.length - 1] : els[0]
    }
    const old = document.getElementById('tc-anno')
    if (old) old.remove()
    const wrap = document.createElement('div')
    wrap.id = 'tc-anno'
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none'
    const out = []
    for (const m of list) {
      const el = pick(m)
      if (!el) {
        out.push(m.num + '×')
        continue
      }
      let b = el.getBoundingClientRect()
      /* tight：块级 div 的 rect 是整行宽，用 Range 收紧到文字实际范围，框才贴字 */
      if (m.tight) {
        const r = document.createRange()
        r.selectNodeContents(el)
        const tb = r.getBoundingClientRect()
        if (tb.width > 1 && tb.height > 1) b = tb
      }
      if (!b.width || b.y < -30 || b.y > 1160) {
        out.push(m.num + '?')
        continue
      }
      out.push(String(m.num))
      const box = document.createElement('div')
      box.style.cssText =
        'position:absolute;left:' + (b.x - 5) + 'px;top:' + (b.y - 5) + 'px;width:' +
        (b.width + 10) + 'px;height:' + (b.height + 10) + 'px;border:3px solid #e8112d;' +
        'border-radius:8px;box-shadow:0 0 0 3px rgba(255,255,255,.92),0 0 0 7px rgba(232,17,45,.20);'
      wrap.appendChild(box)
      const badge = document.createElement('div')
      badge.textContent = String(m.num)
      const bLeft = (m.at === 'right' ? b.x + b.width - 17 : b.x - 19) + (m.bx || 0)
      const bTop = (m.at === 'right' ? b.y + b.height - 17 : b.y - 19) + (m.by || 0)
      badge.style.cssText =
        'position:absolute;left:' + bLeft + 'px;top:' + bTop + 'px;width:36px;height:36px;' +
        'border-radius:50%;background:#e8112d;color:#fff;font:700 21px/36px "Microsoft YaHei",sans-serif;' +
        'text-align:center;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);'
      wrap.appendChild(badge)
    }
    document.body.appendChild(wrap)
    return out
  }, marks)
  if (marks.length && log.some((x) => /[×?]/.test(x))) console.log('  !! 标注异常：' + log.join(','))
  await page.waitForTimeout(150)
  await page.screenshot({ path: path.join(OUT, name) })
  shots.push(name)
  console.log('  ✓ ' + name)
  await page.evaluate(() => {
    const e = document.getElementById('tc-anno')
    if (e) e.remove()
  })
}

async function waitToast(text, timeout = 20000) {
  await page.waitForFunction(
    (t) => [...document.querySelectorAll('.ant-message-notice-content')].some((e) => (e.textContent || '').includes(t)),
    text,
    { timeout },
  )
  /* 提示条入场动画约 300ms，动画中 getBoundingClientRect 在视口外，等它落定 */
  await page.waitForTimeout(450)
}

async function openImportModal() {
  await page.locator('button:has-text("批量导入")').first().click()
  await modal().waitFor({ state: 'visible' })
  await page.waitForTimeout(400)
}

async function closeVisibleModal() {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
}

try {
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({
    /* 高度 1150：预览弹窗内容较高，940 会把底部的「确认导入」按钮挤出视口 */
    viewport: { width: 1500, height: 1150 },
    deviceScaleFactor: 2,
    acceptDownloads: true,
  })
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e)))

  /* ---------- 01 登录页 ---------- */
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[placeholder="岗位账号"]', { timeout: 20000 })
  await page.waitForTimeout(600)
  await shot('01-登录页.png', [
    { num: 1, css: 'input[placeholder="岗位账号"]' },
    { num: 2, css: 'input[placeholder="密码"]' },
    { num: 3, css: 'button.ant-btn-primary' },
    { num: 4, css: '.ant-card-body button', text: '老板' },
  ])

  /* ---------- 登录 ---------- */
  await page.fill('input[placeholder="岗位账号"]', 'boss')
  await page.fill('input[placeholder="密码"]', 'wufu123')
  await page.click('button:has-text("登 录")')
  await page.waitForURL(/dashboard|search|inventory/, { timeout: 20000 })
  await page.waitForTimeout(1300)

  /* ---------- 02 左侧菜单 ---------- */
  const toggle = page.locator('.ant-layout-sider .ant-menu-submenu-title:has-text("进销存")').first()
  if (await toggle.count()) {
    const cls = (await toggle.getAttribute('class')) || ''
    if (!/ant-menu-submenu-open/.test(cls)) await toggle.click()
  }
  await page.waitForTimeout(700)
  await shot('02-左侧菜单.png', [
    { num: 1, css: '.ant-layout-sider .ant-menu-submenu-title', text: '进销存' },
    { num: 2, css: '.ant-layout-sider .ant-menu-item', text: '入库单' },
  ])

  /* ---------- 03 入库单页面 ---------- */
  await page.locator('.ant-layout-sider .ant-menu-item:has-text("入库单")').first().click()
  await page.waitForURL(/inventory\/inbound/, { timeout: 15000 })
  await page.waitForSelector('.ant-table-row', { timeout: 20000 })
  await page.waitForTimeout(1000)
  await shot('03-入库单页面.png', [
    { num: 1, css: 'button', text: '批量导入', by: -26 },
    { num: 2, css: '.ant-table-thead th', text: '操作' },
  ])

  /* ---------- 04 导入弹窗（未选文件） ---------- */
  await openImportModal()
  await shot('04-导入弹窗.png', [
    { num: 1, css: '.ant-modal-content button', text: '选择文件' },
    { num: 2, css: '.ant-modal-content button', text: '下载导入模板' },
    { num: 3, css: '.ant-modal-content .ant-alert-info' },
    { num: 4, css: '.ant-modal-content .ant-empty' },
    { num: 5, css: '.ant-modal-footer button.ant-btn-primary' },
  ])

  /* ---------- 05 预览 ---------- */
  await page.locator('input[type=file]').last().setInputFiles(CSV_GOOD)
  await page.waitForSelector('.ant-modal-content .ant-table', { timeout: 20000 })
  await page.waitForTimeout(1100)
  await shot('05-预览.png', [
    { num: 1, css: '.ant-modal-content .ant-tag', text: '合计应付' },
    { num: 2, css: '.ant-modal-content .ant-table' },
    { num: 3, css: 'input[placeholder="未指定供应商"]' },
    { num: 4, css: '.ant-modal-content .ant-checkbox-wrapper' },
    { num: 5, css: '.ant-modal-footer button.ant-btn-primary' },
  ])

  /* ---------- 06 提交后：待审核 ---------- */
  await page.locator('.ant-modal-footer button.ant-btn-primary').last().click()
  await waitToast('已登记')
  const rows = page.locator('.ant-table-tbody tr.ant-table-row')
  await rows.first().waitFor({ state: 'visible', timeout: 15000 })
  const iNo = await cellIdx('单号')
  const iStatus = await cellIdx('状态')
  const newNo = (await rows.first().locator('td').nth(iNo).innerText()).trim()
  console.log('  新单号 = ' + newNo)
  await shot('06-导入完成待审核.png', [
    { num: 1, css: '.ant-message-notice-content', last: true },
    { num: 2, row: 0, td: iNo },
    { num: 3, row: 0, td: iStatus },
    { num: 4, css: '.ant-alert', text: '待审核' },
  ])

  /* ---------- 07 确认入库弹窗 ---------- */
  await rows.first().locator('button:has-text("确认入库")').first().click()
  await modal().waitFor({ state: 'visible' })
  await page.waitForTimeout(600)
  await shot('07-确认入库弹窗.png', [
    { num: 1, css: '.ant-modal-content .ant-modal-body p' },
    { num: 2, css: '.ant-modal-footer button.ant-btn-primary' },
  ])

  /* ---------- 08 已入库 ---------- */
  await page.locator('.ant-modal-footer button.ant-btn-primary').last().click()
  await waitToast('已确认入库')
  await page.waitForTimeout(1200)
  await rows.first().waitFor({ state: 'visible' })
  const iDebt = await cellIdx('欠款')
  await shot('08-已入库.png', [
    { num: 1, row: 0, td: iStatus },
    { num: 2, row: 0, td: iDebt },
    { num: 3, row: 0, btn: '结算单', bx: -30, by: 34 },
  ])
  /* 等「已确认入库」提示自然消失，避免串到下一张图里 */
  await page.waitForTimeout(2600)

  /* ---------- 09 结算单弹窗 ---------- */
  await rows.first().locator('button:has-text("结算单")').first().click()
  await modal().waitFor({ state: 'visible' })
  await page.waitForTimeout(800)
  await shot('09-结算单弹窗.png', [
    { num: 1, css: '.ant-modal-content .ant-picker' },
    { num: 2, css: '.ant-modal-content .ant-modal-body div', text: '应付全额', smallest: true, tight: true },
    { num: 3, css: '.ant-modal-content .ant-modal-body div', text: '人民币大写', smallest: true, tight: true, at: 'right' },
    { num: 4, css: '.ant-modal-footer button', text: '导出 PDF' },
  ])

  /* ---------- 10 导出 PDF ---------- */
  const dl = page.waitForEvent('download', { timeout: 40000 }).catch(() => null)
  await page.locator('.ant-modal-footer button:has-text("导出 PDF")').click()
  await waitToast('已导出 PDF', 40000)
  await shot('10-导出PDF.png', [{ num: 1, css: '.ant-message-notice-content', last: true }])
  const d = await dl
  console.log('  导出文件 = ' + (d ? await d.suggestedFilename() : '(未捕获)'))

  /* ---------- 11 批量结算单 ---------- */
  await closeVisibleModal()
  await page.locator('button:has-text("批量结算单")').first().click()
  await modal().waitFor({ state: 'visible' })
  await page.waitForTimeout(900)
  await shot('11-批量结算单.png', [
    { num: 1, css: '.ant-modal-content .ant-typography', text: '已选', by: -26 },
    { num: 2, css: '.ant-modal-content button', text: '仅选有欠款', by: 40 },
    { num: 3, css: '.ant-modal-footer button', text: '导出选中 · PDF' },
  ])
  await closeVisibleModal()

  /* ---------- 12 负向：.xls 不支持 ---------- */
  await openImportModal()
  await page.locator('input[type=file]').last().setInputFiles(FAKE_XLS)
  await waitToast('暂不支持')
  await shot('12-xls报错.png', [{ num: 1, css: '.ant-message-notice-content', last: true }])
  await page.waitForTimeout(3200)

  /* ---------- 13 负向：表头识别不到 → 手动指定列 ---------- */
  await page.locator('input[type=file]').last().setInputFiles(BAD_HEADER)
  await waitToast('未识别到进货单表头')
  await page.waitForTimeout(900)
  console.log('  表头报错已捕获')
  await shot('13-手动指定列.png', [
    { num: 1, css: '.ant-message-notice-content', last: true },
    { num: 2, css: '.ant-modal-content .ant-alert-warning table' },
    { num: 3, css: '.ant-modal-content .ant-alert-warning .ant-select' },
    { num: 4, css: '.ant-modal-content button', text: '按此重新解析' },
  ])
  await page.waitForTimeout(500)
  await shot('14-手动指定列-下半.png', [
    { num: 1, css: '.ant-modal-content .ant-alert-warning .ant-select' },
    { num: 2, css: '.ant-modal-content button', text: '按此重新解析' },
    { num: 3, css: '.ant-modal-footer button.ant-btn-primary' },
  ])

  if (errs.length) console.log('\n页面 JS 错误：' + JSON.stringify(errs.slice(0, 5), null, 1))
  console.log('\n共 ' + shots.length + ' 张 → ' + OUT)
} catch (e) {
  console.error('截图失败：', e)
  try {
    await page.screenshot({ path: path.join(OUT, 'zz-失败现场.png') })
  } catch {}
  process.exitCode = 1
} finally {
  if (browser) await browser.close()
}
