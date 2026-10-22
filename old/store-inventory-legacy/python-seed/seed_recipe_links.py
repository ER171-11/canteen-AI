#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
seed_recipe_links.py — 菜谱全链条「数据缝合」（批0，幂等，可重复执行）

干四件事（+ 一件可选）：
  a. 原料别名：解析 recipes 表 BOM 行原料名 ↔ docs.data ings 实名，
     生成 alias map 写入 docs.data 的 config.ing_alias（键=BOM 名，值=ings 实名）。
     自动判不定的走 MANUAL_ALIAS 人工表；表中也没有的列入「未映射」报告，绝不错映射。
  b. 填充 DB.rec：按 dishes.sku_id 把 recipes 的 BOM 写进 DB.rec，
     行格式对齐店内 HTML：DB.rec[dishId] = [{ing: ingId, qty: 数量(按 ing.unit 换算)}]
     （dishRecipeCost 口径：cost += (qty/yld)*avg，avg 是 ing.unit 的单价）。
  c. dishAlias：sales 里的菜品短名（长寿饺/三鲜饺等，按 color→SKU 对应）
     写入 docs.data.dishAlias，结构对齐店内 HTML：dishAlias[净名] = {dish, mul}。
     同时给无 lines 的平铺 sales 记录补 lines:[{dish, qty}]——店内 ingUseIn/dailyUseMap
     只认 s.lines 结构，不补则反解空转。
  d. 占位价修复：9 个 SKU-WF-* 占位菜品 price=0 → 用保本价盘（menu-baoben.json）
     回填 price/est/cost（五色→五福饺子，白→全家福水饺）。
  e. （默认开，--no-plan 关）按店内 restockLines 同口径重算日均耗量并生成一张
     pending 补货建议单进 DB.plans（已有 pending 单则跳过），让 BFF
     /api/inventory/restock-suggest 能吃到 plans 来源；同时把日均耗量回填 ings.est
     （仅当 est 为空）。

写库方式：走店内 HTTP API（GET /api/db → 改 → PUT /api/db，rev 乐观锁，409 自动重试），
服务端 Store.put 会自动留 snapshots 快照，无需重启服务（每次请求都重读 SQLite）。

用法：
  python3 seed_recipe_links.py --dry-run     # 只打印改动计划，不写库
  python3 seed_recipe_links.py               # 实跑
"""
import argparse
import copy
import json
import math
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(BASE_DIR, "data", "餐厅系统.db")
DEFAULT_STORE = "http://127.0.0.1:8765"
BAOBEN_PATHS = [
    os.path.join(BASE_DIR, "..", "bff", "data", "menu-baoben.json"),
    os.path.join(BASE_DIR, "..", "apps", "boss-app", "public", "menu-baoben.json"),
]

# ---------------- 人工别名表（自动匹配判不定时的裁定，宁可不映射不可错映射） ----------------
# 键 = BOM 原料名（去括号后），值 = docs.data ings 实名
MANUAL_ALIAS = {
    "猪前肩肉": "前腿半肥肉",        # 同猪前段部位；库里另有「黑猪前肩肉」但无均价，留给测试 SKU 精确名
    "冬菇": "香菇",                # 冬菇=干香菇
    "食盐": "雪天精制盐",           # 店内唯一食盐（测试 SKU 的 BOM 也用它）
    "白绵糖": "白糖",              # 绵白糖→店内白糖
    "葱花": "大葱",                # 店内无小葱，葱花取自大葱
    "姜末": "生姜",
    "海天蚝油": "海天上等蚝油1kg",   # 另一候选「海天金字蚝油6kg」为餐饮大桶，取有均价的小规格
    "海天生抽": "海天金标生抽1.9L",
    "海天老抽": "海天草菇老抽1.9L",
    "味精": "莲花细味精908g",       # 另一候选「味丹味精」按件计无规格，取规格明确的
    "料油": "5L金龙鱼非转大豆油",    # 料油=香料炸制植物油，以大豆油计
    "香油": "金永丰香麻油860ml",     # 另一候选「鲁花芝麻油 350ml」无均价
    "南瓜泥": "南瓜",
    "菠菜汁": "菠菜",
    "木耳": "云耳(好)",             # 木耳=云耳
    "香芹": "芹菜",
    "花椒": "花椒粒",              # 另一候选「青花椒」，取红花椒粒
    "大料": "八角",                # 大料=八角
    "王守义十三香": "十三香45g",
    "荸荠": "去皮马蹄",             # 荸荠=去皮马蹄（与共享核心 ING_ALIAS_FALLBACK 一致）
    "五得利雪花粉八星": "五得利雪花面粉",  # 面皮基料规格名 → 库里实名
}

# 无对应 ings、确认不映射的 BOM 名（清水按 0 成本跳过；其余进 missing 报告）
SKIP_NAMES = {"清水", "料水"}

# 规格不明、无法从名称解析克重的 ings，按市售常见规格假定（打印在报告里，可复核）
ASSUMED_SPEC_G = {
    "雪天精制盐": 500.0,        # 常见 500g/包
    "食用墨鱼汁": 90.0,         # 进口墨鱼汁常见 90g/瓶
    "紫薯粉": 100.0,            # 常见 100g/瓶
    "东北酸菜(切丝)": 500.0,     # 常见 500g/包
}

# BOM 数量单位 → 克
UNIT_TO_G = {"g": 1.0, "克": 1.0, "kg": 1000.0, "斤": 500.0, "两": 50.0,
             "ml": 1.0, "l": 1000.0, "L": 1000.0, "升": 1000.0, "": 1.0}

# 一份 = 多少只饺子（sales.qty 是「份」，recipes BOM 是「一批」，
# DB.rec/dishRecipeCost 口径是「每份」：qty_份 = qty_批 ÷ 一批出成_个 × PORTION_PIECES。
# 菜谱未给每份只数，按水饺常见出餐 15 只/份取定，打印在报告里可复核调整）
PORTION_PIECES = 15

QTY_RE = re.compile(r"^(.+?)\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z一-鿿%]*)$")
PAREN_RE = re.compile(r"[（(][^）)]*[）)]")
SPEC_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|升)")


def strip_parens(s):
    return PAREN_RE.sub("", str(s or "")).strip()


def clean_name(s):
    """对齐店内 HTML cleanName()：去首尾空白/星号/间隔号。"""
    s = str(s if s is not None else "")
    s = re.sub(r"^[\s　*＊·・]+", "", s)
    s = re.sub(r"[\s　*＊]+$", "", s)
    return s.strip()


def parse_qty_text(s):
    """'猪前肩肉500g' → ('猪前肩肉', 500.0, 'g')；失败返回 (原文, 0, 'g')。"""
    m = QTY_RE.match(str(s or "").strip())
    if not m:
        return str(s or "").strip(), 0.0, "g"
    name = m.group(1).strip()
    try:
        qty = float(m.group(2))
    except ValueError:
        qty = 0.0
    unit = (m.group(3) or "g").strip() or "g"
    return name, qty, unit


def parse_bom_line(line):
    """
    一条 BOM 字符串 → [(name, qty_g, 原文)] 列表（可能展开多条）。
    复用 queue_consumer._parse_bom_qty_line 的正则口径，额外处理：
      - 名称尾括号：'香油13g（古币牌）' → 香油 13g
      - 复合行：'料水200g（花椒10g、大料5g、小茴香5g、香叶3g）' → 展开为 4 条香料
      - 顿号并列：'紫薯粉20g、清水220g' → 2 条
    """
    out = []
    s = str(line or "").strip()
    if not s:
        return out
    # 复合行：括号内含带数量的顿号子项 → 展开子项（主料水本身是水，跳过）
    inner = re.search(r"[（(]([^）)]*[0-9][^）)]*)[）)]", s)
    head = PAREN_RE.sub("", s).strip()
    if inner and ("、" in inner.group(1)):
        for seg in inner.group(1).split("、"):
            n, q, u = parse_qty_text(seg)
            if n and q > 0:
                out.append((n, q * UNIT_TO_G.get(u, 1.0), s))
        return out
    # 顿号并列且每段都带数量 → 拆分
    if "、" in head:
        segs = [parse_qty_text(x) for x in head.split("、")]
        if all(q > 0 for _, q, _ in segs):
            for n, q, u in segs:
                out.append((n, q * UNIT_TO_G.get(u, 1.0), s))
            return out
    n, q, u = parse_qty_text(head)
    if n and q > 0:
        out.append((n, q * UNIT_TO_G.get(u, 1.0), s))
    return out


def grams_per_unit(g):
    """1 个 ing.unit 等于多少克（avg 是 per-unit 价，成本=qty_g/本值*avg）。"""
    unit = str(g.get("unit") or "").strip()
    name = str(g.get("name") or "")
    if unit == "斤":
        return 500.0
    if unit in ("kg", "公斤"):
        return 1000.0
    if unit in ("g", "克"):
        return 1.0
    m = SPEC_RE.search(name)
    if m:
        v = float(m.group(1))
        u = m.group(2)
        return v * (1000.0 if u in ("kg", "L", "l", "升") else 1.0)
    if name in ASSUMED_SPEC_G:
        return ASSUMED_SPEC_G[name]
    return None


def strip_spec(name):
    """去名称尾部规格（1.9L/900g/45g/500ml 等）用于匹配。"""
    return SPEC_RE.sub("", str(name or "")).strip(" *xX/件瓶包桶罐盒支袋")


def load_recipes(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT sku_id, name, color, face_main, main, aux, seasoning, params"
            " FROM recipes ORDER BY sku_id"
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        d = dict(r)
        for col in ("main", "aux", "seasoning", "params"):
            try:
                d[col] = json.loads(d[col]) if d[col] else ([] if col != "params" else {})
            except (TypeError, ValueError):
                d[col] = [] if col != "params" else {}
        out.append(d)
    return out


def recipe_bom_entries(rec):
    """一个 recipe → [(bom_name, qty_g, 原文, 部位)]（部位=面皮/主料/辅料/调味）。"""
    entries = []
    for col, part in (("face_main", "面皮"), ("main", "主料"), ("aux", "辅料"), ("seasoning", "调味")):
        v = rec.get(col)
        lines = v if isinstance(v, list) else ([v] if v else [])
        for line in lines:
            for name, qty_g, raw in parse_bom_line(line):
                entries.append((name, qty_g, raw, part))
    return entries


def resolve_ing(bom_name, ings, report):
    """BOM 名 → ing 行。精确 → 人工表 → 去规格精确 → 唯一双向包含。判不定返回 None。"""
    name = bom_name.strip()
    by_name = {str(g.get("name") or "").strip(): g for g in ings}
    if name in by_name:
        return by_name[name], "精确"
    if name in MANUAL_ALIAS:
        tgt = MANUAL_ALIAS[name]
        if tgt in by_name:
            return by_name[tgt], "人工表"
        report.append("人工表目标不存在：%s → %s" % (name, tgt))
        return None, None
    # 去规格后精确
    sn = strip_spec(name)
    for g in ings:
        if strip_spec(g.get("name")) == sn and sn:
            return g, "去规格"
    # 唯一双向包含
    hits = [g for g in ings
            if (name and name in str(g.get("name") or "")) or
               (sn and len(sn) >= 2 and sn in str(g.get("name") or "")) or
               (str(g.get("name") or "") and str(g.get("name")) in name)]
    if len(hits) == 1:
        return hits[0], "包含"
    return None, None


def load_baoben():
    for p in BAOBEN_PATHS:
        p = os.path.abspath(p)
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f), p
    return None, None


def http_json(method, url, payload=None):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser(description="菜谱全链条数据缝合（批0）")
    ap.add_argument("--store-url", default=DEFAULT_STORE)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--days", type=int, default=30, help="日均耗量回看天数（对齐店内 restock.days）")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-plan", action="store_true", help="不生成补货建议单/不回填 ings.est")
    args = ap.parse_args()

    recipes = load_recipes(args.db)
    print("[i] recipes 表 %d 行：%s" % (len(recipes), "、".join(r["sku_id"] for r in recipes)))

    cur = http_json("GET", args.store_url + "/api/db")
    rev = cur["rev"]
    data = cur["data"]
    print("[i] 店内库 rev=%d ings=%d dishes=%d sales=%d rec=%d dishAlias=%d plans=%d"
          % (rev, len(data.get("ings") or []), len(data.get("dishes") or []),
             len(data.get("sales") or []), len(data.get("rec") or {}),
             len(data.get("dishAlias") or {}), len(data.get("plans") or [])))

    ings = data.get("ings") or []
    dishes = data.get("dishes") or []
    sales = data.get("sales") or []
    warn = []

    # ---------- a. 原料别名 ----------
    alias = {}          # BOM 名（含原始带括号形） → ings 实名
    unmapped = {}       # BOM 名 → 出现的 SKU 列表
    ing_used = {}       # ings 实名 → ing 行
    bom_entries_by_sku = {}
    for rec in recipes:
        entries = recipe_bom_entries(rec)
        bom_entries_by_sku[rec["sku_id"]] = entries
        for name, qty_g, raw, part in entries:
            if name in SKIP_NAMES:
                continue
            g, how = resolve_ing(name, ings, warn)
            if g is None:
                unmapped.setdefault(name, set()).add(rec["sku_id"])
                continue
            real = str(g.get("name"))
            alias[name] = real
            ing_used[real] = g
    # 同时给「原始带括号名」也立键（queue_consumer 拿到的 payload 名可能带括号）
    for rec in recipes:
        for col in ("face_main", "main", "aux", "seasoning"):
            v = rec.get(col)
            lines = v if isinstance(v, list) else ([v] if v else [])
            for line in lines:
                m = QTY_RE.match(str(line or "").strip())
                raw_name = m.group(1).strip() if m else ""
                head = strip_parens(raw_name)
                if raw_name and head in alias:
                    alias.setdefault(raw_name, alias[head])

    print("\n== a. 原料别名（config.ing_alias：BOM 名 → ings 实名）==")
    for k in sorted(alias):
        g = ing_used.get(alias[k])
        gpu = grams_per_unit(g) if g else None
        spec_note = ""
        if g and alias[k] in ASSUMED_SPEC_G:
            spec_note = "（规格假定 %g g/%s）" % (ASSUMED_SPEC_G[alias[k]], g.get("unit"))
        print("  %s → %s [ing=%s unit=%s avg=%s gpu=%s]%s"
              % (k, alias[k], g.get("id") if g else "?", g.get("unit") if g else "?",
                 g.get("avg") if g else "?", gpu, spec_note))
    if unmapped:
        print("  -- 未映射（无对应 ings，进成本卡 missing，不猜）--")
        for k in sorted(unmapped):
            print("  !! %s  (SKU: %s)" % (k, "、".join(sorted(unmapped[k]))))
    for w in warn:
        print("  [warn] " + w)

    # ---------- b. DB.rec ----------
    dishes_by_sku = {}
    for d in dishes:
        sku = d.get("sku_id")
        if sku:
            dishes_by_sku.setdefault(str(sku), []).append(d)
    rec_new = copy.deepcopy(data.get("rec") or {})
    rec_report = []
    for rec in recipes:
        sku = rec["sku_id"]
        targets = dishes_by_sku.get(sku) or []
        if not targets:
            rec_report.append("  !! %s 无挂 sku_id 的菜品，跳过" % sku)
            continue
        lines = []
        params = rec.get("params") or {}
        try:
            batch_pieces = int(params.get("一批出成_个") or 67)
        except (TypeError, ValueError):
            batch_pieces = 67
        if batch_pieces <= 0:
            batch_pieces = 67
        ratio = PORTION_PIECES / batch_pieces  # 批 → 份
        for name, qty_g, raw, part in bom_entries_by_sku[sku]:
            if name in SKIP_NAMES:
                continue
            real = alias.get(name)
            g = ing_used.get(real)
            if not g:
                continue
            gpu = grams_per_unit(g)
            if not gpu:
                rec_report.append("  !! %s 规格不明无法换算，跳过 rec 行：%s（%s）"
                                  % (sku, name, real))
                continue
            qty = round(qty_g * ratio / gpu, 4)
            lines.append({"ing": str(g.get("id")), "qty": qty})
        # 同原料多行（如面皮食盐+馅料食盐）合并
        merged = {}
        for l in lines:
            merged[l["ing"]] = round(merged.get(l["ing"], 0) + l["qty"], 4)
        lines = [{"ing": k, "qty": v} for k, v in merged.items()]
        for d in targets:
            rec_new[str(d["id"])] = lines
        rec_report.append("  %s → 菜品 %s，%d 行" % (
            sku, "、".join(str(d["id"]) for d in targets), len(lines)))
    print("\n== b. DB.rec 填充（{ing, qty} qty=每份用量，按 ing.unit 换算；批→份按 %d 只/份）=="
          % PORTION_PIECES)
    print("\n".join(rec_report))
    print("  rec 菜品数：%d → %d" % (len(data.get("rec") or {}), len(rec_new)))

    # ---------- c. dishAlias + sales 补 lines ----------
    # color → SKU（从 recipes 取；白一色多 SKU，短名销量只有五色，无碍）
    color_sku = {}
    for rec in recipes:
        c = str(rec.get("color") or "")
        if c and c not in color_sku:
            color_sku[c] = rec["sku_id"]
    dish_by_id = {str(d.get("id")): d for d in dishes}
    dish_by_name = {str(d.get("name") or ""): d for d in dishes}

    alias_base = dict(data.get("dishAlias") or {})
    alias_delta = {}
    short_names = sorted({str(s.get("dish") or "") for s in sales if s.get("dish")})
    print("\n== c. dishAlias 与 sales.lines ==")
    for nm in short_names:
        key = clean_name(nm)
        if key in alias_base or key in alias_delta:
            continue
        colors = {str(s.get("color") or "") for s in sales if s.get("dish") == nm}
        target = None
        if nm in dish_by_name:
            target = dish_by_name[nm]
        elif len(colors) == 1 and next(iter(colors)) in color_sku:
            sku = color_sku[next(iter(colors))]
            target = dish_by_id.get(sku)  # 占位菜品 id == sku_id
        if target is not None:
            alias_delta[key] = {"dish": str(target["id"]), "mul": 1}
            print("  别名 %s → %s（%s）" % (key, target["id"], target.get("name")))
        else:
            print("  !! 短名 %s 无法定位菜品（colors=%s），不映射" % (nm, "、".join(sorted(colors))))
    alias_all = dict(alias_base)
    alias_all.update(alias_delta)

    def sale_dish_id(s, amap):
        nm = str(s.get("dish") or "")
        a = amap.get(clean_name(nm))
        if a and str(a.get("dish")) in dish_by_id:
            return str(a["dish"])
        if nm in dish_by_name:
            return str(dish_by_name[nm]["id"])
        c = str(s.get("color") or "")
        if c in color_sku and color_sku[c] in dish_by_id:
            return color_sku[c]
        return None

    def apply_sales_lines(sales_list, amap):
        """幂等：无 lines 的平铺 sales 补 lines:[{dish, qty}]，返回补条数。"""
        added = 0
        for s in sales_list:
            if isinstance(s.get("lines"), list) and s["lines"]:
                continue
            did = sale_dish_id(s, amap)
            if not did:
                continue
            try:
                qty = float(s.get("qty"))
            except (TypeError, ValueError):
                continue
            s["lines"] = [{"dish": did, "qty": qty}]
            added += 1
        return added

    sales_probe = copy.deepcopy(sales)
    lines_added = apply_sales_lines(sales_probe, alias_all)
    print("  sales 补 lines：%d / %d 条" % (lines_added, len(sales)))

    # ---------- d. 占位价修复 ----------
    bb_doc, bb_path = load_baoben()
    bb_by_name = {it["name"]: it for it in (bb_doc or {}).get("items", []) if it.get("name")}

    def apply_price_fix(dishes_list):
        """幂等：SKU-WF-* 占位菜品 price<=0 → 保本价盘回填 price/est/cost。"""
        fixed = []
        for d in dishes_list:
            sku = str(d.get("sku_id") or "")
            if not sku.startswith("SKU-WF-"):
                continue
            try:
                if float(d.get("price") or 0) > 0:
                    continue
            except (TypeError, ValueError):
                pass
            rec_row = next((r for r in recipes if r["sku_id"] == sku), None)
            color = str((rec_row or {}).get("color") or d.get("cat") or "")
            bb = bb_by_name.get("全家福水饺") if color == "白" else bb_by_name.get("五福饺子")
            if not bb:
                continue
            d["price"] = float(bb["price"])
            if not float(d.get("est") or 0) > 0:
                d["est"] = float(bb["cost"])
            if not float(d.get("cost") or 0) > 0:
                d["cost"] = float(bb["cost"])
            d["_u"] = datetime.now().astimezone().isoformat(timespec="seconds")
            fixed.append("  %s price 0 → %s，est/cost → %s（%s）"
                         % (sku, bb["price"], bb["cost"], bb["name"]))
        return fixed

    dishes_probe = copy.deepcopy(dishes)
    price_fixed = apply_price_fix(dishes_probe)
    print("\n== d. SKU-WF-* 占位价回填（来源 %s）==" % (bb_path or "无"))
    print("\n".join(price_fixed) if price_fixed else "  无需修复")

    # ---------- e. 日均耗量 + 补货建议单（同店内 restockLines 口径） ----------
    est_report = []
    plan_new = None
    if not args.no_plan:
        cfg = data.get("restock") or {}
        days = int(cfg.get("days") or args.days)
        lead = float(cfg.get("lead") or 0)
        gap = float(cfg.get("gap") or 0)
        today = datetime.now().strftime("%Y-%m-%d")
        from_day = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
        use = {str(g.get("id")): 0.0 for g in ings}
        ing_by_id = {str(g.get("id")): g for g in ings}
        for s in sales_probe:
            day = str(s.get("date") or s.get("ts") or "")[:10]
            if not day or day < from_day or day > today:
                continue
            for sl in (s.get("lines") or []):
                dd = dish_by_id.get(str(sl.get("dish")))
                if not dd:
                    continue
                for rl in (rec_new.get(str(dd["id"])) or []):
                    g = ing_by_id.get(str(rl.get("ing")))
                    if not g:
                        continue
                    yld = float(g.get("yld") or 1) or 1
                    use[str(g["id"])] += (float(sl.get("qty") or 0) * float(rl.get("qty") or 0)) / yld
        lines = []
        for g in ings:
            if g.get("on") is False:
                continue
            gid = str(g.get("id"))
            daily = round(use.get(gid, 0.0) / days, 4)
            safe = float(g.get("safe") or 0)
            cur_stock = float(g.get("stock") or 0)
            conv = max(0.0001, float(g.get("conv") or 1))
            need = round(max(0.0, daily * (lead + gap) + safe - cur_stock), 3)
            if daily > 0 and not float(g.get("est") or 0) > 0:
                est_report.append((g.get("name"), daily, g.get("unit")))
            if need <= 0:
                continue
            b = need / conv
            try:
                moq = float(g.get("moq") or 0)
            except (TypeError, ValueError):
                moq = 0.0
            if moq > 0:
                b = max(b, moq)
            try:
                pack = float(g.get("pack") or 0)
            except (TypeError, ValueError):
                pack = 0.0
            if pack > 0:
                b = math.ceil(b / pack - 1e-9) * pack
            sug = round(b, 2)
            if sug <= 0:
                continue
            price = g.get("last")
            if not price:
                price = round(float(g.get("avg") or 0) * conv, 2)
            lines.append({"ing": gid, "cur": round(cur_stock, 3), "safe": safe,
                          "daily": daily, "onway": 0, "need": need, "sug": sug,
                          "unit": g.get("unit"), "buy": g.get("buy"), "conv": g.get("conv"),
                          "qty": sug, "price": price, "supplier": g.get("sup") or "",
                          "st": "pending", "name": g.get("name")})
        lines.sort(key=lambda l: -l["need"])
        pending = [p for p in (data.get("plans") or []) if p.get("status") == "pending"]
        if pending:
            print("\n== e. 已有 pending 补货建议单（%s），跳过生成 ==" % pending[0].get("no"))
        elif lines:
            seq = len([p for p in (data.get("plans") or []) if p.get("date") == today]) + 1
            plan_new = {
                "id": "BYseed%s" % datetime.now().strftime("%H%M%S"),
                "no": "BY%s-%03d" % (today.replace("-", ""), seq),
                "date": today,
                "genAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "by": "seed_recipe_links",
                "status": "pending",
                "lines": lines,
            }
            print("\n== e. 生成补货建议单 %s：%d 品项（日均耗量近 %d 天 × (lead %g + gap %g) + 安全 − 现存）=="
                  % (plan_new["no"], len(lines), days, lead, gap))
            for l in lines[:10]:
                print("  %s 日均 %s%s 现 %s → 建议补 %s" % (l["name"], l["daily"], l["unit"], l["cur"], l["sug"]))
        else:
            print("\n== e. 无需补货（库存覆盖或耗量为 0）==")
        if est_report:
            print("  回填 ings.est（日耗）：%s"
                  % "、".join("%s=%s%s" % (n, d, u) for n, d, u in est_report[:15]))

    # ---------- 汇总改动 ----------
    changes = {
        "ing_alias": len(alias),
        "unmapped": len(unmapped),
        "rec_dishes": len(rec_new),
        "dishAlias": len(alias_all),
        "sales_lines_added": lines_added,
        "price_fixed": len(price_fixed),
        "plan_lines": len(plan_new["lines"]) if plan_new else 0,
    }
    print("\n== 改动汇总 ==", json.dumps(changes, ensure_ascii=False))

    if args.dry_run:
        print("\n[dry-run] 不写库。")
        return 0

    # ---------- 应用 + PUT（rev 乐观锁，409 重试） ----------
    for attempt in range(3):
        cur = http_json("GET", args.store_url + "/api/db")
        data = cur["data"]
        cfg = data.get("config")
        if not isinstance(cfg, dict):
            cfg = {}
            data["config"] = cfg
        cfg["ing_alias"] = alias
        data["rec"] = rec_new
        base_alias = data.get("dishAlias")
        merged_alias = dict(base_alias) if isinstance(base_alias, dict) else {}
        merged_alias.update(alias_delta)
        data["dishAlias"] = merged_alias
        apply_sales_lines(data.get("sales") or [], merged_alias)
        apply_price_fix(data.get("dishes") or [])
        rec_u = data.get("_recU")
        if not isinstance(rec_u, dict):
            rec_u = {}
            data["_recU"] = rec_u
        now_iso = datetime.now().astimezone().isoformat(timespec="seconds")
        for did in rec_new:
            rec_u.setdefault(did, now_iso)
        if plan_new:
            plans = data.get("plans")
            if not isinstance(plans, list):
                plans = []
                data["plans"] = plans
            if not any(p.get("status") == "pending" for p in plans):
                plans.append(plan_new)
        if est_report:
            daily_by_name = {n: d for n, d, _ in est_report}
            for g in data.get("ings") or []:
                nm = g.get("name")
                if nm in daily_by_name and not float(g.get("est") or 0) > 0:
                    g["est"] = round(daily_by_name[nm], 4)
        try:
            res = http_json("PUT", args.store_url + "/api/db",
                            {"rev": cur["rev"], "data": data, "machine": "SEED"})
        except urllib.error.HTTPError as e:
            if e.code == 409 and attempt < 2:
                print("[warn] rev 冲突，重试 %d" % (attempt + 1))
                continue
            raise
        print("\n[ok] 已写库 rev %s → %s" % (cur["rev"], res.get("rev")))
        break

    # ---------- 断言 ----------
    fin = http_json("GET", args.store_url + "/api/db")
    fd = fin["data"]
    n_rec = len(fd.get("rec") or {})
    n_alias = len((fd.get("config") or {}).get("ing_alias") or {})
    n_dalias = len(fd.get("dishAlias") or {})
    n_sku_priced = len([d for d in (fd.get("dishes") or [])
                        if str(d.get("id") or "").startswith("SKU-WF-")
                        and float(d.get("price") or 0) > 0])
    n_lines = len([s for s in (fd.get("sales") or []) if s.get("lines")])
    n_plans = len([p for p in (fd.get("plans") or []) if p.get("status") == "pending"])
    print("\n== 断言 ==")
    print("  DB.rec 菜品数 = %d（应 >0）%s" % (n_rec, "OK" if n_rec > 0 else "FAIL"))
    print("  config.ing_alias 条数 = %d（BOM 名 %d 个，未映射 %d 个：%s）%s"
          % (n_alias, n_alias + len(unmapped), len(unmapped),
             "、".join(sorted(unmapped)) or "无",
             "OK" if n_alias > 0 else "FAIL"))
    print("  dishAlias 条数 = %d（应 ≥5）%s" % (n_dalias, "OK" if n_dalias >= 5 else "FAIL"))
    print("  SKU-WF-* price>0 个数 = %d / 9 %s" % (n_sku_priced, "OK" if n_sku_priced == 9 else "FAIL"))
    print("  sales 带 lines = %d / %d" % (n_lines, len(fd.get("sales") or [])))
    print("  pending plans = %d" % n_plans)
    ok = n_rec > 0 and n_alias > 0 and n_dalias >= 5 and n_sku_priced == 9
    print("\n%s" % ("全部断言通过" if ok else "存在未过断言，请检查上面 FAIL 项"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
