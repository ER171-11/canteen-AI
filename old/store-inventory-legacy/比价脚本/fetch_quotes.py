# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 外接比价 · 一键抓价脚本
================================================
流水线：  进销存系统「生成本次比价任务」 → 待比价任务.json
          → 本脚本调用 1688 item_search 接口抓价
          → 比价结果.json（供系统「导入比价结果」）+ 比价结果.xlsx（人看）

用法：
    python fetch_quotes.py                          # 自动找最新的 待比价任务*.json
    python fetch_quotes.py --task 待比价任务_2026-09-13.json
    python fetch_quotes.py --limit 3                # 只抓前 3 种原料，先试跑
    python fetch_quotes.py --dry-run                # 免密钥联调：生成示例结果，不发网络请求
    python fetch_quotes.py --out ./out              # 指定输出目录

契约（务必保持一致，否则系统导入会失败/错价）：
    price  = 1 个「采购单位(buy)」的价格，与该原料 conv 口径一致
    per    = 固定 'buy'
    unitPrice = price / conv   （系统导入时会自行再折算一次做校验，此处仅作参考列）
"""

import argparse
import json
import os
import sys
import time
import glob
from datetime import date

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

try:
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    Workbook = None
    Font = PatternFill = Alignment = get_column_letter = None

try:
    import pandas as pd  # noqa: F401  （可选依赖，仅用于二次分析）
except ImportError:  # pragma: no cover
    pd = None

openpyxl = Workbook  # 兼容旧判断写法

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(HERE, "config.json")
TASK_TYPE = "panda-quote-task"
RESULT_TYPE = "panda-quote-result"
RESULT_NAME = "比价结果.json"
EXCEL_NAME = "比价结果.xlsx"


# ----------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------
def load_config(path):
    if not os.path.exists(path):
        die(f"找不到配置文件：{path}\n请在 比价脚本/ 目录下新建 config.json（可参照 生成任务说明.md），填写 api_key/api_secret。")
    with open(path, "r", encoding="utf-8") as f:
        try:
            cfg = json.load(f)
        except json.JSONDecodeError as e:
            die(f"config.json 不是合法 JSON：{e}")
    cfg.setdefault("api_url", "https://api-gw.onebound.cn/1688/item_search")
    cfg.setdefault("api_key", "")
    cfg.setdefault("api_secret", "")
    cfg.setdefault("page_size", 40)
    cfg.setdefault("sleep", 1.5)
    cfg.setdefault("retry", 2)
    cfg.setdefault("sort", "price")
    cfg.setdefault("source", "1688(API)")
    cfg.setdefault("keyword_suffix", "")
    cfg.setdefault("only_direct", True)   # True: 只抓与任务口径一致的原料（conv=1 或已给 buy_price 字段）
    return cfg


def die(msg, code=1):
    print("\n[错误] " + msg, file=sys.stderr)
    sys.exit(code)


def info(msg):
    print(msg, flush=True)


# ----------------------------------------------------------------------
# 任务清单
# ----------------------------------------------------------------------
def find_task_file(explicit=None):
    if explicit:
        if not os.path.exists(explicit):
            die(f"找不到任务文件：{explicit}")
        return explicit
    # 优先当前目录，其次脚本目录，再往上一级（项目根目录）
    cands = []
    for d in (os.getcwd(), HERE, os.path.dirname(HERE)):
        cands += glob.glob(os.path.join(d, "待比价任务*.json"))
    if not cands:
        die("未找到 待比价任务*.json。请先在系统「外接比价」页点击「生成本次比价任务」，"
            "把下载的文件放到本目录，或用 --task 指定路径。")
    cands.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return cands[0]


def load_task(path):
    with open(path, "r", encoding="utf-8") as f:
        try:
            task = json.load(f)
        except json.JSONDecodeError as e:
            die(f"任务文件不是合法 JSON：{e}")
    items = task.get("items") or []
    if not isinstance(items, list) or not items:
        die("任务文件里没有 items，请重新在系统里导出。")
    if task.get("type") and task["type"] != TASK_TYPE:
        info(f"[提示] 任务文件 type={task.get('type')}，非 {TASK_TYPE}，仍尝试按 items 处理。")
    return task, items


# ----------------------------------------------------------------------
# 1688 抓价
# ----------------------------------------------------------------------
def search_1688(cfg, keyword, page=1):
    """调用 onebound 1688 item_search，返回商品 dict 列表；失败返回 []。"""
    if requests is None:
        die("缺少 requests 依赖，请先执行：pip install -r requirements.txt")
    params = {
        "key": cfg["api_key"],
        "secret": cfg["api_secret"],
        "q": keyword,
        "page": page,
        "page_size": cfg["page_size"],
        "sort": cfg["sort"],
    }
    last_err = None
    for attempt in range(int(cfg["retry"]) + 1):
        try:
            resp = requests.get(cfg["api_url"], params=params, timeout=20)
            if resp.status_code == 200:
                data = resp.json()
                items = data.get("items") or data.get("products") or []
                if not items and data.get("error"):
                    info(f"   接口返回错误：{data.get('error')}")
                return items if isinstance(items, list) else []
            last_err = f"HTTP {resp.status_code}"
        except Exception as e:  # noqa: BLE001
            last_err = str(e)
        if attempt < int(cfg["retry"]):
            backoff = 2 ** attempt
            info(f"   第 {attempt + 1} 次请求失败（{last_err}），{backoff}s 后重试…")
            time.sleep(backoff)
    info(f"   × 放弃该关键词：{last_err}")
    return []


def pick_price(raw, cfg):
    """从一条商品里挑出「与任务采购单位口径一致」的价格。

    关键假设：1688 上该品项按「件/箱/袋」报价，与系统里的采购单位同口径。
    本函数只做数值清洗，不做单位换算；若接口能给出规格，则由人工核对 note 列。
    """
    for k in ("price", "price_min", "min_price", "promotion_price"):
        v = raw.get(k)
        if v is None:
            continue
        try:
            f = float(str(v).replace("￥", "").replace("¥", "").strip())
            if f > 0:
                return f
        except (TypeError, ValueError):
            continue
    return None


def normalize(raw, cfg):
    """统一 onebound 各版本字段名。"""
    return {
        "title": raw.get("title") or raw.get("name") or "",
        "num_iid": str(raw.get("num_iid") or raw.get("item_id") or ""),
        "min_qty": raw.get("min_quantity") or raw.get("min_num") or raw.get("moq") or "",
        "shop": raw.get("shop_title") or raw.get("seller_nick") or raw.get("nick") or "",
        "location": raw.get("location") or raw.get("area") or "",
        "url": raw.get("detail_url") or raw.get("item_url") or "",
        "price": pick_price(raw, cfg),
    }


def fetch_for_ingredient(cfg, it, dry_run=False):
    """抓取单个原料，返回结果条目列表（取最便宜的若干条）。"""
    kw = (it.get("keyword") or it.get("ingName") or "").strip()
    suffix = (cfg.get("keyword_suffix") or "").strip()
    if suffix and suffix not in kw:
        kw = f"{kw} {suffix}".strip()

    conv = float(it.get("conv") or 1) or 1
    gname = it.get("ingName") or it.get("ingId")

    if conv != 1 and not cfg.get("allow_conv_grab", False):
        info(f"  - {gname}：换算率 {conv} ≠ 1，跳过（1688 报价口径难以自动对齐；"
             f"如需强制抓取请在 config.json 设 \"allow_conv_grab\": true 后人工核对）")
        return [], "skip_conv"

    if dry_run:
        # 免密钥联调：造一条与任务同构的假数据
        demo_price = round(float(it.get("avg") or 10) * 0.92, 2) or 9.9
        return [{
            "ingId": it.get("ingId"), "ingName": gname, "keyword": kw,
            "source": cfg["source"] + "(示例)", "price": demo_price, "per": "buy",
            "unitPrice": round(demo_price / conv, 4), "minQty": 1, "shop": "示例供应商",
            "location": "示例发货地", "url": "https://example.com/demo",
            "date": date.today().isoformat(), "title": gname + "（示例商品）", "numIid": "100000000000",
            "note": "dry-run 示例数据，非真实报价，请勿导入正式数据",
        }], "ok"

    info(f"  - {gname}：搜索「{kw}」…")
    times = int(cfg.get("pages", 1)) or 1
    rows = []
    for p in range(1, times + 1):
        raw_items = search_1688(cfg, kw, page=p)
        for raw in raw_items:
            n = normalize(raw, cfg)
            if not n["title"] or not n["price"]:
                continue
            rows.append(n)
        if p < times:
            time.sleep(float(cfg["sleep"]))
    if not rows:
        info("    × 无有效结果")
        return [], "empty"

    rows.sort(key=lambda r: r["price"])
    top = rows[: int(cfg.get("top_n", 3)) or 3]
    out = []
    for i, n in enumerate(top):
        price = n["price"]
        note = f"规格核对:{n['title'][:40]}" + (f" | 商品ID:{n['num_iid']}" if n["num_iid"] else "")
        out.append({
            "ingId": it.get("ingId"), "ingName": gname, "keyword": kw,
            "source": cfg["source"] + (f" #{i + 1}" if i else ""),
            "price": price, "per": "buy",
            "unitPrice": round(price / conv, 4),
            "minQty": n["min_qty"], "shop": n["shop"], "location": n["location"],
            "url": n["url"], "date": date.today().isoformat(),
            "title": n["title"], "numIid": n["num_iid"],
            "note": note + (" | 任务口径=采购单位，请核对规格是否同口径" if conv != 1 else ""),
        })
    info(f"    √ 取最低 {len(out)} 条，最低 {out[0]['price']} 元/{it.get('buy')}")
    return out, "ok"


# ----------------------------------------------------------------------
# 输出
# ----------------------------------------------------------------------
def write_json(out_dir, task, cfg, items, stats):
    payload = {
        "type": RESULT_TYPE,
        "version": 1,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "rest": task.get("rest") or "熊猫五福餐厅",
        "source": cfg.get("source", "1688(API)"),
        "stats": stats,
        "items": items,
    }
    path = os.path.join(out_dir, RESULT_NAME)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    info(f"\n已写出结果文件：{path}")
    return path


def write_excel(out_dir, task, cfg, items):
    """写出人看的比价表；折算库存单价 / 差价 / 差价率 用 Excel 公式，改价即自动重算。"""
    if openpyxl is None:
        info("[提示] 未安装 openpyxl，跳过 Excel 导出（pip install -r requirements.txt）")
        return None
    if not items:
        info("[提示] 无数据，未生成 Excel")
        return None

    meta = {i.get("ingId"): i for i in task.get("items", [])}
    headers = ["原料", "分类", "搜索关键词", "来源", "商品标题",
               "批发价(元/采购单位)", "换算率(1采购单位=N库存单位)", "折算库存单价(元)",
               "本店均价(元)", "与本店差价(元)", "差价率", "最小起订量",
               "供应商", "发货地", "商品链接", "日期", "库存单位"]

    wb = Workbook()
    ws = wb.active
    ws.title = "比价结果"
    ws.append(headers)

    head_fill = PatternFill("solid", start_color="FF1F2937")
    head_font = Font(name="微软雅黑", size=10, bold=True, color="FFFFFFFF")
    for c in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = head_fill
        cell.font = head_font
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[1].height = 32

    for it in items:
        m = meta.get(it["ingId"], {})
        conv = float(m.get("conv") or 1) or 1
        avg = m.get("avg")
        avg_val = float(avg) if avg is not None else None
        ws.append([
            it.get("ingName"), m.get("cat", ""), it.get("keyword"), it.get("source"),
            it.get("title") or "",
            float(it.get("price") or 0), conv,
            None,             # H 折算库存单价（公式）
            avg_val,          # I 本店均价（可能为空）
            None, None,       # J 差价 / K 差价率（公式）
            it.get("minQty"), it.get("shop"), it.get("location"),
            it.get("url"), it.get("date"), m.get("unit", ""),
        ])
        r = ws.max_row
        # 全部只用数值运算 + N() 容错，杜绝 #VALUE!/#DIV/0!
        ws.cell(row=r, column=8).value = f"=IF(G{r}>0,F{r}/G{r},F{r})"
        ws.cell(row=r, column=10).value = f"=H{r}-N(I{r})"
        ws.cell(row=r, column=11).value = f"=IF(N(I{r})>0,J{r}/I{r},\"\")"

    last = ws.max_row
    num2 = "0.00;0.00;\"-\""
    for r in range(2, last + 1):
        for c in (6, 8, 9, 10):
            ws.cell(row=r, column=c).number_format = num2
        ws.cell(row=r, column=7).number_format = "0.####"
        ws.cell(row=r, column=11).number_format = "0.0%;-0.0%;\"-\""
        ws.cell(row=r, column=8).font = Font(name="微软雅黑", size=10, bold=True)
        # 外价更低 → 绿字；更高 → 红字（与本店均价比较，按当前数据静态上色）
        avg = ws.cell(row=r, column=9).value or 0
        price = ws.cell(row=r, column=6).value or 0
        conv_r = ws.cell(row=r, column=7).value or 1
        diff_val = round(price / conv_r - avg, 6)
        color = "FF12803A" if diff_val < -0.01 else "FFC0392B" if diff_val > 0.01 else "FF374151"
        for c in (10, 11):
            ws.cell(row=r, column=c).font = Font(name="微软雅黑", size=10, color=color)

    widths = [18, 10, 20, 13, 34, 16, 14, 14, 12, 13, 10, 12, 18, 14, 30, 12, 10]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{last}"

    # 说明页：口径与来源
    ws2 = wb.create_sheet("说明")
    notes = [
        ["熊猫五福餐厅 · 外接比价结果表"],
        ["生成时间", time.strftime("%Y-%m-%d %H:%M:%S")],
        ["报价来源", cfg.get("source", "1688(API)")],
        ["统计", f"成功 {len(items)} 条报价"],
        [],
        ["列名", "口径说明"],
        ["批发价(元/采购单位)", "外部平台该品项按 1 个采购单位报价，与系统里的采购单位(buy)同口径"],
        ["换算率", "1 采购单位 = N 库存单位；来源于系统任务清单的 conv 字段"],
        ["折算库存单价", "= 批发价 / 换算率，用于与本店库存均价直接比较（Excel 公式，改价自动重算）"],
        ["本店均价", "系统移动加权平均库存成本快照，取自生成任务那一刻"],
        ["与本店差价", "= 折算库存单价 - 本店均价；负数=外部更便宜（绿色），正数=外部更贵（红色）"],
        ["差价率", "= 差价 / 本店均价；为 0 或均价缺失时显示 -"],
        [],
        ["注意", "1688 报价可能不含运费/不含税/规格不同，下单前请人工核对商品标题与规格"],
        ["导入方式", "回到系统「外接比价」页 → 导入比价结果 → 选择 比价结果.json（不是本表）"],
    ]
    for row in notes:
        ws2.append(row)
    ws2.column_dimensions["A"].width = 24
    ws2.column_dimensions["B"].width = 92
    ws2["A1"].font = Font(name="微软雅黑", size=13, bold=True)
    for r in (6,):
        ws2.cell(row=r, column=1).font = Font(name="微软雅黑", size=10, bold=True)

    path = os.path.join(out_dir, EXCEL_NAME)
    try:
        wb.save(path)
    except Exception as e:  # noqa: BLE001
        info(f"[警告] Excel 导出失败：{e}")
        return None
    info(f"已写出比价表：{path}")
    return path


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="熊猫五福餐厅 · 1688 一键比价抓价脚本")
    ap.add_argument("--task", help="待比价任务.json 路径（默认自动查找最新）")
    ap.add_argument("--config", default=DEFAULT_CONFIG, help="配置文件路径（默认 config.json）")
    ap.add_argument("--out", default=HERE, help="输出目录（默认脚本所在目录）")
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 种原料（调试用，0=全部）")
    ap.add_argument("--dry-run", action="store_true", help="免密钥联调，生成示例结果不发网络请求")
    args = ap.parse_args()

    info("=" * 62)
    info("熊猫五福餐厅 · 外接比价一键抓价")
    info("=" * 62)

    cfg = load_config(args.config)
    if not args.dry_run and (not cfg["api_key"] or not cfg["api_secret"]):
        die("config.json 里的 api_key / api_secret 为空。\n"
            "  请到 https://www.onebound.cn/ 或 https://api-gw.onebound.cn/ 申请接口密钥后填入，\n"
            "  或先用 --dry-run 跑一次流程验证。")

    task_path = find_task_file(args.task)
    info(f"任务文件：{task_path}")
    task, items = load_task(task_path)
    if args.limit and args.limit > 0:
        items = items[: args.limit]
    info(f"待抓取原料：{len(items)} 种" + ("（dry-run 模式）" if args.dry_run else ""))

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)

    results, skipped = [], []
    stats = {"total": len(items), "ok": 0, "empty": 0, "skip": 0}
    for idx, it in enumerate(items, 1):
        info(f"[{idx}/{len(items)}] {it.get('ingName')}")
        got, status = fetch_for_ingredient(cfg, it, dry_run=args.dry_run)
        if got:
            results.extend(got)
            stats["ok"] += 1
        else:
            skipped.append(it.get("ingName"))
            stats["empty" if status == "empty" else "skip"] += 1
        if idx < len(items):
            time.sleep(float(cfg["sleep"]))

    write_json(out_dir, task, cfg, results, stats)
    write_excel(out_dir, task, cfg, results)

    info("\n" + "-" * 62)
    info(f"完成：成功 {stats['ok']} 种 · 无结果 {stats['empty']} 种 · 跳过 {stats['skip']} 种 "
         f"· 共 {len(results)} 条报价")
    if skipped:
        info("未抓到报价：" + "、".join(skipped[:20]) + ("…" if len(skipped) > 20 else ""))
    info("下一步：回到系统「外接比价」页点击「导入比价结果」，选择 " + RESULT_NAME + " 即可。")
    info("-" * 62)


if __name__ == "__main__":
    main()
