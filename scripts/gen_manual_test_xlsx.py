# -*- coding: utf-8 -*-
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT = "docs/测试与验收/V0.2-P1人工测试清单.xlsx"
F = "Arial"
INK, INK2, BRAND, BSOFT, GREEN, GSOFT, AMBER, ASOFT, GS = "1F2430", "5B6472", "2F6BFF", "EAF0FF", "16A34A", "E9F9EF", "D97706", "FDF3E3", "EEF1F5"
th = Side(style="thin", color="E6E9EF")
BD = Border(left=th, right=th, top=th, bottom=th)

def C(ws, r, c, v, bold=False, size=10, color=INK, bg=None, wrap=True, ha="left", mono=False):
    x = ws.cell(row=r, column=c, value=v)
    x.font = Font(name="Consolas" if mono else F, bold=bold, size=size, color=color)
    if bg: x.fill = PatternFill("solid", start_color=bg)
    x.alignment = Alignment(horizontal=ha, vertical="top", wrap_text=wrap)
    x.border = BD
    return x

def bar(ws, r, text, n, sub=""):
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=n)
    C(ws, r, 1, text, True, 14, "FFFFFF", BRAND, ha="center")
    for c in range(1, n + 1):
        ws.cell(row=r, column=c).fill = PatternFill("solid", start_color=BRAND)
        ws.cell(row=r, column=c).border = BD
    ws.row_dimensions[r].height = 28
    if sub:
        ws.merge_cells(start_row=r + 1, start_column=1, end_row=r + 1, end_column=n)
        C(ws, r + 1, 1, sub, False, 10, INK2, GS, ha="left")
        for c in range(1, n + 1):
            ws.cell(row=r + 1, column=c).fill = PatternFill("solid", start_color=GS)
            ws.cell(row=r + 1, column=c).border = BD
        ws.row_dimensions[r + 1].height = 20
        return r + 2
    return r + 1

def head(ws, r, cols):
    for i, h in enumerate(cols, 1):
        C(ws, r, i, h, True, 10, "FFFFFF", INK, ha="center")
    ws.row_dimensions[r].height = 22
    return r + 1

def widths(ws, cols):
    for i, w in enumerate(cols, 1):
        ws.column_dimensions[get_column_letter(i)].width = w

BADGE = {"单测": (GREEN, GSOFT), "接口": (BRAND, BSOFT), "回归": (AMBER, ASOFT)}

def casesheet(name, title, sub, rows, cols=(10, 20, 9, 30, 30, 46, 38, 18)):
    ws = wb.create_sheet(name)
    widths(ws, cols)
    r = bar(ws, 1, title, len(cols), sub)
    r = head(ws, r, ["用例编号", "测试项", "类型", "测试位置（文件/端点）", "前置条件/测试数据", "操作步骤（命令/请求）", "预期结果", "判定通过标准"])
    for no, it, tp, loc, pre, st, ex, std in rows:
        C(ws, r, 1, no, True, ha="center")
        C(ws, r, 2, it, True)
        tc, tb = BADGE[tp]
        C(ws, r, 3, tp, True, color=tc, bg=tb, ha="center")
        C(ws, r, 4, loc, mono=True, color=INK2)
        C(ws, r, 5, pre)
        C(ws, r, 6, st, mono=True, color=INK2)
        C(ws, r, 7, ex)
        C(ws, r, 8, std, True, 10, GREEN)
        h = max(len(st.split("\n")), len(pre.split("\n")), len(ex.split("\n"))) + 1
        ws.row_dimensions[r].height = min(160, max(44, h * 14))
        r += 1
    return ws

wb = Workbook()
ws = wb.active
ws.title = "测试总览"
widths(ws, (8, 18, 50, 40))
r = bar(ws, 1, "V0.2 P1 批次新增功能 · 人工测试清单（W6 / W3 / W5）", 4, "W6 菜谱 BOM 中间材料 · W3 产品超链接（质检报告/资质）· W5 检索域隔离。生成日期 2026-10-20")
r = head(ws, r, ["序号", "准备项", "操作 / 命令", "说明"])
prep = [
    ("1", "启动 BFF 服务", "cd c:/Users/mingyzhikui/Desktop/canteenAI/bff\nnode server.js", "监听 0.0.0.0:8787（BFF_HOST/BFF_PORT 可改）。启动后 GET http://127.0.0.1:8787/api/health 应返回 ok:true。"),
    ("2", "登录获取 token", 'curl -X POST http://127.0.0.1:8787/api/auth/login -H "Content-Type: application/json" -d "{\\"account\\":\\"boss\\"}"', "demo 模式（ALLOW_DEMO_LOGIN 默认开启）无需密码；boss/manager/finance/kitchen/cashier 对应角色，boss/店长可写。响应 JSON 取 token。"),
    ("3", "请求认证头", "Authorization: Bearer <token>", "除 /、/health、/api/health、登录注册、/api/app/* 外的 /api/* 均需带此头，否则 401。"),
    ("4", "测试数据隔离（建议）", '$env:BFF_DATA_DIR = "C:/temp/canteen-test-data"\nnode server.js', "快照默认存 bff/data/snapshot.json。用 BFF_DATA_DIR 指向临时目录隔离测试数据；测试前先备份真实 snapshot.json。"),
    ("5", "自动化单测", "cd bff\nnode lib/recipe_cost.test.js   # W6\nnode lib/supply.test.js      # W3\nnode lib/search.test.js      # W5", "三个单测 node 直跑、零第三方依赖，输出「全部通过」且退出码 0 为通过。"),
    ("6", "全量回归", "cd bff\nnpm test", "串联算法层/seed/路由/lib 各测试；改动后需确认 npm test 仍全绿。"),
    ("7", "curl 提示（Windows）", "使用 curl.exe 或 Postman / Git Bash", "PowerShell 中 curl 可能被别名到 Invoke-WebRequest，建议显式用 curl.exe 或 Postman。"),
]
for it in prep:
    C(ws, r, 1, it[0], ha="center")
    C(ws, r, 2, it[1], True)
    C(ws, r, 3, it[2], mono=True, color=INK2)
    C(ws, r, 4, it[3])
    ws.row_dimensions[r].height = max(30, 14 * (it[2].count("\n") + 1) + 8)
    r += 1

TOK = "Authorization: Bearer <token>"

casesheet("W6-菜谱BOM中间材料", "W6 · 菜谱 BOM 引入中间材料（半成品）", "核心：bff/lib/recipe_cost.js buildCostCard 第三参数 semiLib（ext.recipes type='semi'）递归展开 + 防环 + 等比缩放", [
    ("W6-1", "递归展开 + 防环 + 缩放（单测）", "单测", "bff/lib/recipe_cost.test.js\n核心：lib/recipe_cost.js", "无（单测自带数据）", "cd bff\nnode lib/recipe_cost.test.js", "逐项 ✓，末尾「recipe_cost.test.js 全部通过」，exit 0。覆盖 100g 料水等比缩放、嵌套半成品、防环、无库时旧口径跳过。", "全部断言 ✓ 且 exit 0"),
    ("W6-2", "现有配方成本不变（回归）", "回归", "GET /api/workbench/kitchen\n入口：routes/workbench.js", "已登录；当前 ext.recipes 无 type='semi' 行（默认种子）", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/workbench/kitchen"', "各菜品成本卡 bom_lines 不含「料水/清水」行；batch_cost/unit_cost/portion_cost 与改造前一致；missing_ings 仍含料水（预期，不编造成本）。", "成本数值与改造前一致、无报错"),
    ("W6-3", "构造 type='semi' 后递归展开（端到端）", "接口", "POST /api/snapshot/push\n验证：GET /api/workbench/kitchen", "ext.recipes 追加 {\"sku_id\":\"SEMI-LS\",\"name\":\"料水\",\"type\":\"semi\",\"params\":{\"一批出成_g\":200},\"seasoning\":[\"花椒10g\",\"大料5g\",\"小茴香5g\",\"香叶3g\"]}；某配方 BOM 加「料水100g」；改好 {rev,data,ext} 整体回灌", '① curl -X POST http://127.0.0.1:8787/api/snapshot/push -H "' + TOK + '" -H "Content-Type: application/json" -d @snapshot_modified.json\n② curl -H "' + TOK + '" "http://127.0.0.1:8787/api/workbench/kitchen"', "「料水100g」配方成本卡 bom_lines 展开为 花椒5g/大料2.5g/小茴香2.5g/香叶1.5g（100/200 缩放）；batch_cost 按香料原料价累加；missing_ings 不含料水。", "展开克重正确、成本按香料价累加"),
    ("W6-4", "成本 CSV 交叉验证", "回归", "GET /api/export/dishes.csv\n入口：routes/export.js", "已完成 W6-2 或 W6-3", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/export/dishes.csv"', "CSV 菜品成本列与 kitchen 成本卡 batch_cost/portion_cost 一致，无异常值。", "CSV 成本与 kitchen 口径一致"),
])

casesheet("W3-产品超链接", "W3 · 产品超链接（质检报告 / 资质）", "核心：lib/algorithms/inventory.js（ings.qc_report_url、sup_vendors.certs）+ lib/supply.js（certSummary 复用 foodsafety.certLevel/daysLeft）", [
    ("W3-1", "资质归一 + 临期分级（单测）", "单测", "bff/lib/supply.test.js\n核心：lib/supply.js", "无", "cd bff\nnode lib/supply.test.js", "逐项 ✓，末尾「supply.test.js 全部通过」。覆盖 certs 归一、certSummary 五档、vendorsReport cert_expiring 三档。", "全部断言 ✓ 且 exit 0"),
    ("W3-2", "供应商资质录入（vendor.upsert + certs）", "接口", "POST /api/supply/vendor\n核心：lib/algorithms/inventory.js upsertVendor/normalizeCerts", "已登录 boss（可写）", 'curl -X POST http://127.0.0.1:8787/api/supply/vendor -H "' + TOK + '" -H "Content-Type: application/json" -d "{\\"name\\":\\"甲乙供应商\\",\\"certs\\":[{\\"type\\":\\"营业执照\\",\\"cert_no\\":\\"X1\\",\\"expire_at\\":\\"2026-12-31\\",\\"url\\":\\"http://x/1.jpg\\"}]}"\n→ 返回 id → POST /api/actions/{id}/confirm → POST /api/actions/{id}/apply', "入队成功（queued + id）；apply 后 sup_vendors（或 data.vendors）中「甲乙供应商」含归一 certs 数组。", "certs 正确写入"),
    ("W3-3", "资质分级 + 临期清单展示", "接口", "GET /api/supply/vendors\n核心：lib/supply.js vendorsReport", "已完成 W3-2 写入（含临期/逾期证照）", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/supply/vendors"', "每行供应商带 cert（level/days_left/next_expire_at/expired_count）；响应含 cert_expiring 清单（仅 expired/red/orange）。", "cert.level 与到期日匹配、清单正确"),
    ("W3-4", "供应链看板临期告警", "接口", "GET /api/supply/overview\n核心：lib/supply.js overviewReport", "已完成 W3-2 写入（含逾期证照）", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/supply/overview"', "响应含 cert_expiring；advice 出现「资质已逾期 N 家」或「资质临期 N 家」文案。", "告警文案与临期数量一致"),
    ("W3-5", "原料质检报告链接（ing.upsert + qc_report_url）", "接口", "POST /api/actions（type=ing.upsert）\n核心：lib/algorithms/inventory.js applyIngUpsert", "已登录 boss；data.ings 存在「东北酸菜」", 'curl -X POST http://127.0.0.1:8787/api/actions -H "' + TOK + '" -H "Content-Type: application/json" -d "{\\"type\\":\\"ing.upsert\\",\\"payload\\":{\\"name\\":\\"东北酸菜\\",\\"qc_report_url\\":\\"http://x/qc.pdf\\"},\\"operator\\":\\"boss\\"}"\n→ 返回 id → confirm → apply', "apply 后 data.ings「东北酸菜」行新增 qc_report_url；缺省未传时不写该键（不污染存量）。", "qc_report_url 正确写入"),
])

casesheet("W5-检索域隔离", "W5 · 检索域隔离 + 搜索索引字段管控", "核心：lib/search.js（六域 + 索引白名单 + SENSITIVE_FIELDS 黑名单双保险）+ routes/search.js", [
    ("W5-1", "敏感字段不入索引 + 域隔离（单测）", "单测", "bff/lib/search.test.js\n核心：lib/search.js", "无", "cd bff\nnode lib/search.test.js", "逐项 ✓，末尾「search.test.js 全部通过」。覆盖税号/内部编码/成本价/金额/薪资/身份证不入索引、名称/规格可检索、单域不串味。", "全部断言 ✓ 且 exit 0"),
    ("W5-2", "业务域枚举", "接口", "GET /api/search/domains\n入口：routes/search.js", "已登录", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/search/domains"', "返回 6 域 key + 中文标签：procurement 商品采购 / finance 财务税务 / foodsafety 食安 / staff 员工 / equipment 设备 / sale 销售。", "6 域齐全、label 正确"),
    ("W5-3", "全局分域检索", "接口", "GET /api/search?q=\n入口：routes/search.js", "已登录；快照存在「东北酸菜」", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/search?q=%E4%B8%9C%E5%8C%97%E9%85%B8%E8%8F%9C"', "返回 domains，domains.procurement.count>=1 且命中原料；total=各域 count 之和；各域独立返回不混排。", "命中域正确、total=各域和"),
    ("W5-4", "单域检索不串味", "接口", "GET /api/search?domain=&q=\n入口：routes/search.js", "已登录", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/search?domain=procurement&q=%E9%85%B8%E8%8F%9C"', "只返回 procurement 域 hits，不出现 finance/staff 等域记录。", "结果均属指定域"),
    ("W5-5", "敏感字段隔离（税号/成本价/金额/薪资）", "接口", "GET /api/search?q=\n入口：routes/search.js", "已登录；快照存在含税号/avg/amount 的记录", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/search?q=<税号或成本价数字>"', "total=0；税号/供应商内部编码/成本价/金额/薪资/身份证永不进索引。", "敏感字段检索 total=0"),
    ("W5-6", "非法域校验", "接口", "GET /api/search?domain=\n入口：routes/search.js", "已登录", 'curl -H "' + TOK + '" "http://127.0.0.1:8787/api/search?domain=hack&q=x"', "400，返回 {ok:false,error:\"unknown domain: hack\",valid:[6 域]}。", "返回 400 + valid 清单"),
])

wb.save(OUT)
print("saved", OUT)
