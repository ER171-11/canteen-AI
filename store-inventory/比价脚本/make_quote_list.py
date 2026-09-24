"""把 待比价任务.json 转换成 1688「清单询价」适用的 Excel 模板与说明文档。

输入: 比价脚本/待比价任务_YYYY-MM-DD.json  (或命令行 --task 指定)
输出: 询价清单/询价清单_YYYY-MM-DD.xlsx
      询价清单/询价清单说明_YYYY-MM-DD.md

Excel 设计：
- 每个原料类目一张工作表（干调类/水产类/蔬菜类/鲜肉类）
- 列：序号 / 商品名称(搜索关键词) / 规格容量 / 采购单位 / 采购数量 / 当前本店均价 / 期望单价上限 / 备注
- 表头深底白字加粗、冻结首行、自动筛选、列宽自适应
- 「采购数量」列做正整数校验、默认空（用户填）
- 末尾追加「说明」sheet 给出使用步骤

用法：python make_quote_list.py                 # 自动取最新 待比价任务_*.json
      python make_quote_list.py --task <path>   # 指定任务文件
      python make_quote_list.py --out <dir>     # 指定输出目录
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import OrderedDict

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

# ---------- 规格提取（从 ingName 里反推规格描述） ----------
SIZE_RE = re.compile(
    r'(\d+(?:\.\d+)?)\s*(ml|ML|l|L|kg|KG|g|G|克|千克|升|毫升|斤|两|箱|件|瓶|桶|袋|包|盒|只|条|根|块|片)',
    re.U,
)
BRAND_HINT = ("东古", "海天", "家乐", "味好美", "李锦记", "厨邦", "加加",
              "欣和", "金兰", "双汇", "雨润", "金锣", "湾仔码头", "安井",
              "三全", "思念", "正大", "金龙鱼", "福临门", "鲁花",
              "太太乐", "雀巢", "味之素", "联合利华", "海特")


def extract_spec(name):
    m = SIZE_RE.search(name)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    return ""


# ---------- 主流程 ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", help="待比价任务 JSON 路径（默认按时间最新自动找）")
    ap.add_argument("--out", default=None,
                    help="输出目录（默认放在 比价脚本/ 的上一层，即工作区根目录下的 询价清单/）")
    ap.add_argument("--sheets", help="额外指定要拆分的类目（逗号分隔，留空按任务里的 cat 自动）")
    args = ap.parse_args()

    task_path = args.task
    if not task_path:
        # 自动寻找：从当前 cwd 起向上 2 层（即工作区根目录）扫 待比价任务_*.json
        cands = []
        start = os.getcwd()
        for d in [start, os.path.dirname(start), os.path.dirname(os.path.dirname(start))]:
            try:
                cands.extend(glob.glob(os.path.join(d, "**/待比价任务_*.json"), recursive=True))
            except Exception:
                pass
        # 去重 + 按修改时间倒序
        seen = set()
        uniq = []
        for p in cands:
            ap = os.path.abspath(p)
            if ap in seen:
                continue
            seen.add(ap)
            uniq.append(ap)
        uniq.sort(key=os.path.getmtime, reverse=True)
        if not uniq:
            sys.exit("找不到 待比价任务_*.json，请先在系统「外接比价」页点「生成本次比价任务」。")
        task_path = uniq[0]
    task_path = os.path.abspath(task_path)

    with open(task_path, encoding="utf-8") as f:
        task = json.load(f)
    items = task.get("items") or []
    if not items:
        sys.exit("任务文件里没有 items。")

    rest = task.get("rest") or "熊猫五福餐厅"
    today = task.get("items", [{}])[0].get("taskDate") or task.get("generatedAt", "")[:10]
    out_dir = args.out
    if not out_dir:
        # 默认放工作区根目录的 询价清单/ 下
        script_dir = os.path.dirname(os.path.abspath(__file__))
        out_dir = os.path.join(os.path.dirname(script_dir), "询价清单")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    xlsx_path = os.path.join(out_dir, f"询价清单_{today}.xlsx")
    md_path = os.path.join(out_dir, f"询价清单说明_{today}.md")

    # ---- 按 cat 分组 ----
    groups = OrderedDict()
    cat_order = (args.sheets.split(",") if args.sheets else None)
    for it in items:
        groups.setdefault(it.get("cat") or "未分类", []).append(it)
    if cat_order:
        groups = OrderedDict((c, groups[c]) for c in cat_order if c in groups)
        for c, v in groups.items():
            pass  # 保持原顺序

    wb = Workbook()
    wb.remove(wb.active)

    # 样式
    title_font = Font(name="微软雅黑", size=14, bold=True, color="FFFFFFFF")
    title_fill = PatternFill("solid", start_color="FF1F2937")
    head_font = Font(name="微软雅黑", size=10, bold=True, color="FFFFFFFF")
    head_fill = PatternFill("solid", start_color="FF374151")
    sub_fill = PatternFill("solid", start_color="FFEFF6FF")
    cell_font = Font(name="微软雅黑", size=10)
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)
    left = Alignment(horizontal="left", vertical="center", wrap_text=True)
    thin = Side(border_style="thin", color="FFD1D5DB")
    box = Border(left=thin, right=thin, top=thin, bottom=thin)

    headers = ["序号", "商品名称（1688 搜索关键词）", "规格/容量", "采购单位",
               "采购数量", "当前本店均价(元/单位)", "期望单价上限(元/单位)", "备注"]
    col_widths = [6, 28, 12, 10, 10, 14, 14, 28]

    summary_rows = []

    for cat, lst in groups.items():
        ws = wb.create_sheet(cat)
        ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
        t = ws.cell(row=1, column=1,
                    value=f"{rest} · {cat} · 询价清单 · {today} · 共 {len(lst)} 项")
        t.font = title_font
        t.fill = title_fill
        t.alignment = center
        ws.row_dimensions[1].height = 30

        # 表头
        for c, h in enumerate(headers, start=1):
            cell = ws.cell(row=2, column=c, value=h)
            cell.font = head_font
            cell.fill = head_fill
            cell.alignment = center
            cell.border = box
        ws.row_dimensions[2].height = 30

        # 数据
        total_avg = 0.0
        for r, it in enumerate(lst, start=3):
            spec = extract_spec(it["ingName"])
            ws.cell(row=r, column=1, value=r - 2).alignment = center
            ws.cell(row=r, column=2, value=it["keyword"]).alignment = left
            ws.cell(row=r, column=3, value=spec).alignment = center
            ws.cell(row=r, column=4, value=it["buy"]).alignment = center
            qty = ws.cell(row=r, column=5, value=None)  # 留空让用户填
            qty.alignment = center
            qty.fill = sub_fill
            avg_v = it.get("avg") or 0
            ws.cell(row=r, column=6, value=float(avg_v)).number_format = "0.00"
            ws.cell(row=r, column=6).alignment = center
            ws.cell(row=r, column=7, value=None).alignment = center  # 期望单价上限
            ws.cell(row=r, column=8, value=None).alignment = left
            for c in range(1, 9):
                cell = ws.cell(row=r, column=c)
                if cell.font is None or cell.font.name != "微软雅黑":
                    cell.font = cell_font
                cell.border = box
            total_avg += float(avg_v)

        # 数量列数据校验：正整数
        dv = DataValidation(type="whole", operator="greaterThan", formula1=0,
                            allow_blank=True, showErrorMessage=True,
                            errorTitle="采购数量格式不对",
                            error="请填正整数（如 1、6、24）。留空表示本项不询价。")
        last = ws.max_row
        dv.add(f"E3:E{last}")
        ws.add_data_validation(dv)

        # 期望单价上限：可正实数
        dv2 = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1=0,
                             allow_blank=True, showErrorMessage=True,
                             errorTitle="期望单价格式不对",
                             error="请填 ≥0 的数字，留空表示不限。")
        dv2.add(f"G3:G{last}")
        ws.add_data_validation(dv2)

        # 列宽 / 冻结 / 筛选
        for i, w in enumerate(col_widths, start=1):
            ws.column_dimensions[get_column_letter(i)].width = w
        ws.freeze_panes = "A3"
        ws.auto_filter.ref = f"A2:H{last}"

        summary_rows.append((cat, len(lst), round(total_avg, 2)))

    # ---- 汇总 sheet ----
    ws_all = wb.create_sheet("全部汇总", 0)
    ws_all.merge_cells(start_row=1, start_column=1, end_row=1, end_column=8)
    t = ws_all.cell(row=1, column=1,
                    value=f"{rest} · 询价清单（全部 {len(items)} 项 · 按类目拆分）· {today}")
    t.font = title_font
    t.fill = title_fill
    t.alignment = center
    ws_all.row_dimensions[1].height = 30

    ws_all.append(["类目", "原料数", "本店均价合计(元/单位)", "", "", "", "", ""])
    for c in range(1, 9):
        cell = ws_all.cell(row=2, column=c)
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = center
        cell.border = box
    for r, (cat, n, total) in enumerate(summary_rows, start=3):
        ws_all.cell(row=r, column=1, value=cat).alignment = left
        ws_all.cell(row=r, column=2, value=n).alignment = center
        ws_all.cell(row=r, column=3, value=total).number_format = "0.00"
        ws_all.cell(row=r, column=3).alignment = center
        for c in range(1, 9):
            ws_all.cell(row=r, column=c).border = box
    ws_all.cell(row=len(summary_rows) + 3, column=1,
                value="建议把每个类目 sheet 单独发给对应供应商询价；批量让 1688 AI 客服读取时上传「全部汇总」sheet 也可。").font = Font(
        name="微软雅黑", size=10, italic=True, color="FF6B7280")
    ws_all.merge_cells(start_row=len(summary_rows) + 3, start_column=1,
                       end_row=len(summary_rows) + 3, end_column=8)
    for i, w in enumerate([14, 10, 22, 8, 8, 8, 8, 8], start=1):
        ws_all.column_dimensions[get_column_letter(i)].width = w
    ws_all.freeze_panes = "A3"

    # ---- 说明 sheet ----
    ws_help = wb.create_sheet("使用说明")
    notes = [
        ["熊猫五福餐厅 · 1688 清单询价模板 使用说明"],
        [f"生成时间", today, f"原料总数", len(items)],
        [],
        ["步骤", "操作"],
        ["①", "确认每个类目 sheet 的「商品名称」是 1688 实际能搜到的关键词；搜不到就手动改一两个字（比如「东古一品鲜」→「东古 一品鲜」）"],
        ["②", "在「采购数量」列填正整数（≥1）。留空 = 本次不询价。"],
        ["③", "（可选）在「期望单价上限」填你能接受的最高价，留空 = 不设上限。"],
        ["④", "「备注」可填特殊要求，例如「需提供检测报告」「9 月 25 日前到货」「规格同 2025 年 9 月那批」等。"],
        ["⑤", "全部填好后保存这份 xlsx，登录 1688 买家工作台 → 询报价 → 「清单询价」→ 上传本文件。"],
        [],
        ["关于「采购单位」", "与本系统原料的「采购单位」字段一致（如「瓶」「桶」「件」），方便后续把 1688 报价回填。"],
        ["关于「当前本店均价」", "仅为参考，便于你判断 1688 报价是否划算；不填也不影响询价。"],
        ["关于「规格/容量」", "由商品名自动提取（东古一品鲜500ml → 500ml）；如有误差请在「备注」里补正。"],
        [],
        ["询回后如何回填到系统", "在系统「外接比价」页 → 点「录入报价」手工录入；或扩展一键比价脚本把 1688 客服答复批量解析后导入「比价结果.json」。"],
        ["本文件路径", xlsx_path],
    ]
    for r, row in enumerate(notes, start=1):
        for c, v in enumerate(row, start=1):
            cell = ws_help.cell(row=r, column=c, value=v)
            cell.alignment = left if c == 2 else center
            cell.font = cell_font
            cell.border = box
    ws_help.cell(row=1, column=1).font = Font(name="微软雅黑", size=14, bold=True)
    ws_help.cell(row=4, column=1).font = head_font
    ws_help.cell(row=4, column=1).fill = head_fill
    ws_help.cell(row=4, column=2).font = head_font
    ws_help.cell(row=4, column=2).fill = head_fill
    for i, w in enumerate([10, 90], start=1):
        ws_help.column_dimensions[get_column_letter(i)].width = w
    ws_help.merge_cells(start_row=len(notes), start_column=1, end_row=len(notes), end_column=2)

    # 写入
    wb.save(xlsx_path)

    # ---- Markdown 文档 ----
    md = []
    md.append(f"# 熊猫五福餐厅 · 1688 清单询价说明")
    md.append("")
    md.append(f"- **生成时间**：{today}")
    md.append(f"- **原料总数**：{len(items)} 种（覆盖 {len(groups)} 个类目）")
    md.append(f"- **Excel 模板**：`{os.path.basename(xlsx_path)}`（与本文档同目录）")
    md.append(f"- **任务来源**：`{os.path.basename(task_path)}`")
    md.append("")
    md.append("## 一、询价目标")
    md.append("")
    md.append(
        f"本次把本餐厅全部 {len(items)} 种在用原料打包，让 1688 的「询报价 AI 助理」一次性给到批发价区间，"
        "用于辅助判断是否值得切换供货渠道、或与现有供应商议价。")
    md.append("")
    md.append("## 二、清单按类目拆分")
    md.append("")
    md.append("| 类目 | 原料数 | 本店均价合计 |")
    md.append("| --- | ---: | ---: |")
    for cat, n, total in summary_rows:
        md.append(f"| {cat} | {n} | {total:.2f} |")
    md.append(f"| **合计** | **{len(items)}** | — |")
    md.append("")
    md.append("每个类目单独一个 sheet，方便按类目发给对应供应商；批量询价可上传「全部汇总」sheet。")
    md.append("")
    md.append("## 三、上传前请先做的事")
    md.append("")
    md.append("1. **核对关键词**：抽查 5-10 个商品的「商品名称」是否与 1688 实际商品一致；不一致就改成你熟悉的叫法")
    md.append("2. **填采购数量**：每行填 ≥1 的整数，留空表示该项不参与本次询价")
    md.append("3. **特殊要求**写到备注：例如「保质期 ≥6 个月」「需冷链」「9 月 25 日前到货」")
    md.append("")
    md.append("## 四、操作流程")
    md.append("")
    md.append("1. 打开 [1688 询报价](https://work.1688.com/) → 询报价")
    md.append("2. 选「清单询价」")
    md.append("3. 上传 `询价清单_{}.xlsx`".format(today))
    md.append("4. AI 助理逐项询问 → 回复 → 拿到报价清单")
    md.append("5. 在系统「外接比价」页 → 「录入报价」逐条回填到 `DB.quotes`")
    md.append("")
    md.append("## 五、注意事项")
    md.append("")
    md.append("- 1688 AI 助理的回答**仅供参考**，下单前请人工核对商品规格 / 是否含税 / 是否含运费 / 起批量")
    md.append("- 部分原料（鲜肉 / 蔬菜）可能本地供应商更划算，可挑出来单独询本地批发")
    md.append("- 一次询价品类过多（>30）时 AI 助理可能要求拆分；按 sheet 已经拆分好")
    md.append("- 询回结果如需批量导入系统，可扩展 `比价脚本/fetch_quotes.py` 直接对接本文件解析")
    md.append("")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md))

    print(f"[OK] 已生成 Excel 模板：{xlsx_path}")
    print(f"[OK] 已生成说明文档：{md_path}")
    print(f"     类目分布：{', '.join(f'{c} {n}' for c, n, _ in summary_rows)}")


if __name__ == "__main__":
    main()