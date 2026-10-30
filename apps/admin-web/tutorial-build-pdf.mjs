import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/*
 * 把 教程.html 打成 A4 PDF（并顺带导出一张“打印预览”长图方便自检）
 * 用法：node apps/admin-web/tutorial-build-pdf.mjs
 */
const ROOT = 'C:/Users/mingyzhikui/Desktop/canteenAI'
const DIR = path.join(ROOT, 'docs/教程-入库单导入到结算单')
const HTML = path.join(DIR, '教程.html')
const PDF = path.join(DIR, '入库单导入到结算单-图文教程.pdf')

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2 })
  await page.goto(pathToFileURL(HTML).href, { waitUntil: 'load' })
  await page.evaluate(async () => {
    await document.fonts.ready
    const imgs = [...document.images]
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r }))))
  })
  const broken = await page.evaluate(() => [...document.images].filter((i) => !i.naturalWidth).map((i) => i.src))
  if (broken.length) console.log('!! 图片缺失：' + JSON.stringify(broken))

  await page.emulateMedia({ media: 'print' })
  await page.waitForTimeout(300)
  await page.pdf({
    path: PDF,
    preferCSSPageSize: true,
    printBackground: true,
  })
  const size = fs.statSync(PDF).size
  console.log('PDF = ' + PDF + '（' + Math.round(size / 1024) + ' KB）')

  /* 自检长图：按 A4 宽度整页截一张，肉眼看版式 */
  await page.screenshot({ path: path.join(ROOT, '.tmp-tutorial/logs/教程-预览.png'), fullPage: true })
  console.log('预览长图 = .tmp-tutorial/logs/教程-预览.png')
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  await browser.close()
}
