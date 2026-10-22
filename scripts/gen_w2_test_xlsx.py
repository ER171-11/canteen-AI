# -*- coding: utf-8 -*-
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

OUT = "docs/测试与验收/W2-受控词表Tag-前端测试清单.xlsx"
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

BADGE = {"只读": (GREEN, GSOFT), "写操作": (BRAND, BSOFT), "回归": (AMBER, ASOFT), "接口": (INK2, GS)}

def casesheet(name, title, sub, rows):
    ws = wb.create_sheet(name)
    widths(ws, (10, 20, 9, 32, 28, 50, 40, 20))
    r = bar(ws, 1, title, 8, sub)
    r = head(ws, r, ["用例编号", "测试项", "类型", "测试位置（页面/文件/端点）", "前置条件", "操作步骤（前端）", "预期结果", "判定通过标准"])
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
        ws.row_dimensions[r].height = min(170, max(44, h * 14))
        r += 1
    return ws

wb = Workbook()

# ===================== Sheet 1 测试总览 =====================
ws = wb.active
ws.title = "测试总览"
widths(ws, (8, 18, 52, 42))
r = bar(ws, 1, "W2 受控词表 Tag · 前端访问测试清单", 4, "从前端页面（admin-web）验证受控词表申请/审核/上架、原料 Tag 关联与别名搜索是否可用。生成日期 2026-10-20")
r = head(ws, r, ["序号", "准备项", "操作 / 命令", "说明"])
prep = [
    ("1", "启动演练环境（必须）",
     "双击根目录「启动演练.cmd」",
     "一键拉起 store-node(8765) + BFF(8787) + 店内消费器 consumer(5s) + 回写器 pusher(60s) + admin-web(5173)，浏览器自动打开 http://localhost:5173。必须用它：写操作靠消费器落库，只起 BFF 会卡「待执行」。"),
    ("2", "登录（写权限）",
     "登录页一键点「老板」，或账号 boss / 密码 wufu123",
     "写操作（申请词条/关联 Tag）需老板或店长角色；只读页面用只读账号即可。demo 登录默认免密校验。"),
    ("3", "菜单导航",
     "进销存 → 原料库存（/inventory/stock）\n审批中心（/platform/actions）",
     "受控词表 Tag 的前端入口在「原料库存」页；写操作提交后在「审批中心」点「通过」才落库。"),
    ("4", "数据可见性时序（关键）",
     "提交 → 审批「通过」→ 消费器落库(约5s，动作变「已执行」) → pusher 回写快照(最长约60s) → 前端刷新可见",
     "前端读的是 pusher 回写的快照（bff/data/snapshot.json）。写操作落库后需等约 1 分钟（或 pusher 下一轮回写）刷新页面才能看到最新状态；动作状态「已执行」是落库信号。"),
    ("5", "数据隔离与重置",
     "演练库：store-inventory/data/餐厅系统_演练.db\n重置：node scripts/sandbox-db.js --reset",
     "演练模式走沙盒库，不碰真实数据；测试可反复重置。"),
    ("6", "后端单测自检（可选）",
     "cd bff\nnode lib/algorithms/terms.test.js",
     "词条状态机（申请/上架/驳回/改名/改别名）与原料 Tag 关联的算法自检，node 直跑零依赖，全 ✓ 为通过。"),
    ("7", "只读 API 直连校验（可选）",
     "GET /api/inventory/ing-terms\nGET /api/inventory/ing-terms/match?q=东北产地",
     "词表列表与「别名→词条ID→命中原料」精确匹配端点，用于与前端本地过滤做交叉核对（需带 Bearer token）。"),
]
for it in prep:
    C(ws, r, 1, it[0], ha="center")
    C(ws, r, 2, it[1], True)
    C(ws, r, 3, it[2], mono=True, color=INK2)
    C(ws, r, 4, it[3])
    ws.row_dimensions[r].height = max(30, 14 * (it[2].count("\n") + 1) + 8)
    r += 1

# ===================== Sheet 2 W2 用例 =====================
casesheet("W2-受控词表Tag", "W2 · 受控词表 Tag（前端访问验证）",
          "前端页面：apps/admin-web/src/pages/inventory/StockPage.tsx（库存/产品库 + 受控词条管理 Modal）。写侧走 /api/actions 队列（term.upsert / ing.attr_set），经审批中心确认后由店内消费器落库。", [
    ("T01", "受控词表查看", "只读",
     "进销存 → 原料库存 →「词条管理」按钮\nGET /api/inventory/ing-terms",
     "已用「启动演练.cmd」启动并登录 boss",
     "进入「库存 / 产品库」页 → 点右上「词条管理」按钮 → 打开弹窗",
     "弹窗标题「受控词条管理（申请 → 审核 → 上架）」，列出受控词表：按 8 维度（产地/颜色/部位/等级/品种/规格/包装/口味）归类的种子词条（T001~T015），状态均为「已上架」（绿）。",
     "8 维度齐全、种子词条可见、状态正确"),
    ("T02", "申请新词条", "写操作",
     "词条管理 Modal →「申请词条」表单\nterm.upsert（入队）",
     "已登录 boss（写权限）",
     "在词条管理弹窗顶部：词条名填「青花椒」→ 维度选「品种」→ 别名填「藤椒」（逗号分隔多别名）→ 点「申请词条」",
     "提示「已提交词条申请（待审核上架）」；列表新增「青花椒」，状态「待审核」（橙）；动作 term.upsert 已入队并自动 confirm（审批中心可见「待执行」）。",
     "提示成功、新词条进入「待审核」"),
    ("T03", "审批上架词条", "写操作",
     "审批中心 /platform/actions（ActionsPage.tsx）",
     "已完成 T02 提交",
     "切到「审批中心」→ 找到「词条申请 / 青花椒」动作 → 点「通过」→ 观察状态变化",
     "动作状态由「待执行」→「已执行」（店内消费器约 5s 落库）；若 20s 仍「待执行」，页面出现「数据还没落库」红色硬告警，说明消费器未在运行（需用「启动演练.cmd」）。",
     "动作最终「已执行」、无落库告警"),
    ("T04", "上架后前端可见", "只读",
     "进销存 → 原料库存 →「词条管理」（刷新）",
     "T03 已「已执行」且 pusher 已回写（约 1 分钟）",
     "刷新页面 → 重新打开「词条管理」",
     "「青花椒」状态由「待审核」变「已上架」（绿），别名「藤椒」可见。",
     "新词条状态变「已上架」"),
    ("T05", "词条驳回 / 下架 / 重新上架", "写操作",
     "词条管理 Modal 操作列\nterm.upsert（status 变更）",
     "已登录 boss",
     "对「待审核」词条点「驳回」；对「已上架」词条点「下架」；对「已驳回」词条点「重新上架」→ 每次变更后到审批中心「通过」→ 刷新",
     "三种状态流转均提示成功；审批落库后词条状态对应变为「已驳回」（灰）/「已上架」（绿）。驳回或下架的词条不再出现在编辑原料的可选词条里。",
     "状态机 pending↔active↔rejected 流转正确"),
    ("T06", "编辑原料关联受控 Tag + 自定义 Tag", "写操作",
     "原料库存 →「新增原料」/「编辑」→ 字段「标签 / 属性（受控词条 + 自定义）」\ning.upsert（主数据）+ ing.attr_set（tags 独立入队）",
     "已登录 boss；已有上架词条（如「东北」T001）",
     "打开新增/编辑原料弹窗 → 在「标签 / 属性」字段选择标准词条「东北」（产地），并手动输入自定义 Tag「夏季清仓」→ 保存",
     "提示「已保存」。字段说明显示「仅用于检索与归类，不影响成本与库存」；tags 从主数据剥离、独立走 ing.attr_set 入队（不混入成本/库存口径）。",
     "保存成功、tags 独立入队"),
    ("T07", "审批通过后 Tag 显示", "只读",
     "审批中心 → 通过 ing.attr_set → 刷新原料库存",
     "已完成 T06；审批「已执行」+ pusher 回写",
     "审批中心「通过」该原料的「属性设置 / 标签」动作 → 刷新原料库存列表",
     "该原料行「标签/属性」列显示：「东北」（蓝，受控词条 Tag）+「夏季清仓」（灰，自定义 Tag）。",
     "受控与自定义 Tag 均正确渲染"),
    ("T08", "别名归一搜索", "只读",
     "原料库存页搜索框（StockPage.tsx hitTermId）",
     "已有原料关联「东北」Tag（T07）",
     "在搜索框输入「东北产地」（T001「东北」的别名）",
     "命中带「东北」Tag 的原料（别名归一到词条 T001 后精确匹配 tags）；命中行 Tag 高亮（geekblue）。",
     "别名命中对应词条原料"),
    ("T09", "自定义 Tag 搜索", "只读",
     "原料库存页搜索框",
     "已有原料带自定义 Tag「夏季清仓」（T07）",
     "在搜索框输入「夏季清仓」",
     "命中带该自定义 Tag 的原料（tags 含自定义字符串）。",
     "自定义 Tag 可检索命中"),
    ("T10", "未上架词条不可选", "只读",
     "编辑原料 →「标签 / 属性」Select 选项（termOptions）",
     "存在「待审核」词条（T02 后未上架）",
     "打开编辑原料弹窗 → 展开「标签 / 属性」下拉",
     "「待审核」词条选项置灰 disabled，标签带「（待审）」；仅「已上架」词条可勾选。",
     "待审词条被禁用、上架词条可选"),
    ("T11", "回归：不影响成本与库存", "回归",
     "厨房 → 菜品配方成本卡（/kitchen/recipes 或 工作台）\nGET /api/workbench/kitchen",
     "已完成 T07 关联 Tag",
     "给原料关联 Tag 后，查看引用该原料的菜品成本卡",
     "成本卡 batch_cost/portion_cost 与关联 Tag 前一致；库存数量无变化；tags 仅用于检索归类、不进成本/库存口径。",
     "成本与库存数值无变化"),
    ("T12", "后端精确匹配端点（交叉验证）", "接口",
     "GET /api/inventory/ing-terms/match?q=东北产地\nroutes/inventory.js",
     "已登录，带 Bearer token",
     "浏览器/Postman 直接访问 GET /api/inventory/ing-terms/match?q=东北产地（带认证头）",
     "返回 count>0；items 含带「东北」Tag 的原料；hitTermIds 含 T001。与前端 T08 本地过滤结果一致。",
     "后端口径与前端过滤一致"),
])

wb.save(OUT)
print("saved", OUT)
