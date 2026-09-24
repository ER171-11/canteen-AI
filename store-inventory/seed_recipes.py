#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 五福饺子配方种子脚本（增量组件，核心零改动）

从《金丰御字牌五福饺子(2).docx》解析结构化配方（zipfile + 正则，纯标准库），
按 PRD v1.0 附录 A 的 9 SKU 定义对齐命名，写入本地 SQLite 新表：
  - recipes        （INSERT OR REPLACE，幂等）
  - sop_steps      （INSERT OR REPLACE，按 sku_id+step_no 幂等）
  - sop_workorders （生成 1 条今日示范工单，已存在同日同 SKU 工单则跳过）

红线：
  - 只写新增表，绝不触碰 docs/snapshots 主数据与受保护 HTML。
  - 色源字段锁定：face_main 从 docx 面主料提取（扣除面粉/食盐基料），
    红色 SKU 强制校验必须含「火龙果」，否则中止写入（PRD：红色必须火龙果）。
  - 数值只取 docx 原文与 PRD 通用工艺参数，不编造。

用法：
  python3 seed_recipes.py                 # 解析 + 落库
  python3 seed_recipes.py --dry-run       # 只打印摘要不落库
  python3 seed_recipes.py --db 路径 --docx 路径
"""

import argparse
import json
import logging
import os
import re
import sqlite3
import sys
import zipfile
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(BASE_DIR, "data", "餐厅系统.db")
DEFAULT_DOCX = os.path.join(BASE_DIR, "..", "金丰御字牌五福饺子(2).docx")
MIGRATION_SQL = os.path.join(BASE_DIR, "migrations", "001_new_tables.sql")

log = logging.getLogger("seed_recipes")

# ---------------------------------------------------------------------------
# SKU 定义：与 PRD v1.0 附录 A 的 9 SKU 对齐
# key = (面皮色, 馅料名)；馅料名取自 docx 各节「辅料」行括号标注
# ---------------------------------------------------------------------------
BLESSING = {"红": "长寿", "黄": "富贵", "绿": "康宁", "紫": "好德", "黑": "聚财", "白": "团圆"}  # PRD 附录 A

SKU_DEFS = [
    # (color, filling, sku_id, 成品克重区间[docx 原文])
    ("红", "猪肉冬菇荸荠馅",   "SKU-WF-HONG",        (25, 27)),
    ("黄", "猪肉茴香大葱馅",   "SKU-WF-HUANG",       (25, 27)),
    ("绿", "猪肉玉米馅",       "SKU-WF-LV",          (25, 27)),
    ("紫", "猪肉香芹馅",       "SKU-WF-ZI",          (25, 27)),
    ("黑", "猪肉三鲜馅",       "SKU-WF-HEI",         (25, 27)),
    ("白", "猪肉酸菜馅",       "SKU-WF-BAI-SUANCAI", (25, 27)),
    ("白", "牛肉大葱馅",       "SKU-WF-BAI-NIUROU",  (25, 27)),
    ("白", "西葫芦鸡蛋馅",     "SKU-WF-BAI-XIHULU",  (25, 28)),
    ("白", "猪肉山药馅",       "SKU-WF-BAI-SHANYAO", (25, 28)),
]

# 面皮基料（PRD 附录 A：各 SKU 通用），提取色源时从面主料中扣除
FACE_BASE = ("五得利雪花粉八星500g", "食盐3g")

# PRD 附录 A「关键工艺参数（全 SKU 通用）」+ 任务书给定褶纹标准
COMMON_PARAMS = {
    "剂子_g": [10, 11],
    "醒发_min": 30,
    "点凉水次数": 3,
    "料水加入": "分三次加入，顺同一方向搅至上劲",
    "褶纹": "12-14道",
}

# 忌口/过敏原标签推导规则（由馅料成分直接推出，非编造）
DIET_RULES = [
    ("猪", "含猪肉"), ("牛", "含牛肉"), ("虾仁", "含甲壳类(虾)"),
    ("鸡蛋", "含蛋"), ("木耳", "含菌菇"), ("冬菇", "含菌菇"), ("香菇", "含菌菇"),
]
VEG_FILLINGS = ("西葫芦鸡蛋馅",)  # 9 SKU 中唯一素馅（docx 标注「素」）


# ---------------------------------------------------------------------------
# docx 解析
# ---------------------------------------------------------------------------

def docx_paragraphs(path):
    """解出 word/document.xml，按段落去标签，返回干净文本行列表。"""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&quot;", '"'), ("&apos;", "'")):
        text = text.replace(a, b)
    return [l.strip() for l in text.split("\n") if l.strip()]


def split_items(s):
    """'冬菇100g、荸荠100g' → ['冬菇100g', '荸荠100g']，去掉尾部分号/句号。"""
    s = s.strip().rstrip(";；。")
    return [x.strip() for x in re.split(r"[、，,]", s) if x.strip()]


def parse_sections(lines):
    """
    把 docx 切成「御字牌五福饺子（X色）…」各节，提取：
    面主料/主料/辅料(含馅料名)/调料/制作方法步骤列表。
    返回 {(color, filling): {face, main, aux, seasoning, steps}}
    """
    head_re = re.compile(r"^御字牌五福饺子（(.+?)色）(?:（(.+?)）)?$")
    sections = []
    cur = None
    for line in lines:
        m = head_re.match(line)
        if m:
            cur = {"color": m.group(1), "title_filling": m.group(2), "lines": []}
            sections.append(cur)
            continue
        if cur is not None:
            cur["lines"].append(line)

    out = {}
    for sec in sections:
        rec = {"face": [], "main": [], "aux": [], "seasoning": [],
               "filling": sec["title_filling"], "steps": []}
        in_steps = False
        for line in sec["lines"]:
            if line.startswith("面主料："):
                rec["face"] = split_items(line[len("面主料："):])
            elif line.startswith("主料："):
                rec["main"] = split_items(line[len("主料："):])
            elif line.startswith("辅料："):
                body = line[len("辅料："):]
                fm = re.search(r"（(.+?馅)）", body)
                if fm:
                    rec["filling"] = rec["filling"] or fm.group(1)
                    body = body[:fm.start()] + body[fm.end():]
                rec["aux"] = split_items(body)
            elif line.startswith("调料："):
                rec["seasoning"] = split_items(line[len("调料："):])
            elif line.startswith("制作方法"):
                in_steps = True
            elif in_steps:
                sm = re.match(r"^(\d+)[、.](.+)$", line)
                if sm:
                    rec["steps"].append(sm.group(2).strip())
                elif rec["steps"]:
                    in_steps = False  # 步骤区结束
        if rec["filling"]:
            out[(sec["color"], rec["filling"])] = rec
    return out


def derive_face_main(face_items):
    """色源 = 面主料扣除基料（面粉/食盐）。色源字段锁定，写入后不得擅改。"""
    rest = [x for x in face_items if x not in FACE_BASE]
    return "、".join(rest) if rest else "清水（本色）"


def derive_diet_tags(filling, main, aux):
    tags = []
    blob = filling + "".join(main) + "".join(aux)
    for kw, tag in DIET_RULES:
        if kw in blob and tag not in tags:
            tags.append(tag)
    if filling in VEG_FILLINGS:
        tags.insert(0, "素馅")
    return tags


# ---------------------------------------------------------------------------
# SOP 工序推导：把 docx 逐步骤文本分类到 8 个阶段
# ---------------------------------------------------------------------------

# 顺序即优先级：装盘/剂子靠前，避免「无需醒发直接分割」「成品饺子皮…装盘」误判
STAGE_RULES = [
    ("装盘", ("装盘", "捞出", "沥干")),
    ("剂子", ("剂子", "面剂", "下剂", "分割", "擀")),
    ("醒发", ("醒发",)),
    ("和面", ("和面", "压面", "面团", "面坯", "破壁机", "打成泥", "打成汁", "烫面", "榨汁")),
    ("包制", ("捏合", "封口", "包制", "舀入", "置于饺皮", "置于面皮", "饺子皮中央", "托盘")),
    ("煮制", ("煮", "凉水", "沸腾", "浮起", "粘底", "勺背")),
    ("拌馅", ("搅拌", "上劲", "料油", "香油", "调味", "馅料", "翻拌", "拌匀")),
    ("备馅", ("绞", "切", "焯水", "挤", "泡", "炒熟", "晾凉", "备用", "熬煮", "滤")),
]

QC_BY_STAGE = {
    "和面": "面团表面光滑、色泽均匀无干粉",
    "醒发": "醒发足 30 分钟",
    "备馅": "刀工均匀、脱水到位",
    "拌馅": "料水分三次加入、顺同一方向搅至上劲",
    "剂子": "剂子称重 10-11g、擀皮中间厚边缘薄",
    "包制": "成品 25-27g（白色部分 25-28g）、封口严密无漏馅、褶纹 12-14 道",
    "煮制": "三次点凉水，浮起鼓胀出锅",
    "装盘": "沥干不积水、五色错落",
}

RISK_BY_STAGE = {
    "和面": "色源比例偏差导致串色/色差",
    "醒发": "醒发不足面皮僵硬易破",
    "备馅": "脱水不净导致馅料泄汤",
    "拌馅": "搅拌方向不一致导致馅料泄汤",
    "剂子": "剂子超重导致皮馅比失衡",
    "包制": "封口不严煮制漏馅",
    "煮制": "点水不足内生/过度破皮浑汤",
    "装盘": "余热积水泡烂饺皮",
}

TOOL_KEYWORDS = ("破壁机", "压面机", "绞肉机", "拌馅盆", "和面盆", "馅料盆",
                 "调馅容器", "平底锅", "蒸锅", "保鲜膜")

KEY_POINT_RE = re.compile(
    r"(\d+-\d+g|\d+g|三次|同一方向|上劲|30分钟|食盐|料水|料油|香油)")


def classify_step(text):
    for stage, kws in STAGE_RULES:
        if any(k in text for k in kws):
            return stage
    return "备馅"


def build_sop_steps(sku_id, steps):
    """docx 步骤 → sop_steps 行。时长仅醒发 30min 有出处，其余留空不编造。"""
    rows = []
    for i, text in enumerate(steps, 1):
        stage = classify_step(text)
        tools = [t for t in TOOL_KEYWORDS if t in text]
        rows.append({
            "sku_id": sku_id,
            "step_no": i,
            "stage": stage,
            "duration_min": 30 if "醒发" in text and "30" in text else None,
            "tools": tools,
            "inputs": [],
            "key_points": text,
            "qc_point": QC_BY_STAGE.get(stage, ""),
            "risk": RISK_BY_STAGE.get(stage, ""),
            "params": {},
        })
    return rows


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def build_recipes(docx_path):
    lines = docx_paragraphs(docx_path)
    sections = parse_sections(lines)
    log.info("docx 解析出色×馅小节 %d 个: %s",
             len(sections), ["%s/%s" % k for k in sections])

    recipes, sop = [], []
    missing = []
    for color, filling, sku_id, weight in SKU_DEFS:
        rec = sections.get((color, filling))
        if rec is None:
            missing.append("%s/%s" % (color, filling))
            continue
        face_main = derive_face_main(rec["face"])
        # 红线校验：红色必须火龙果（PRD 4.1.1 约束）
        if color == "红" and "火龙果" not in face_main:
            raise SystemExit("红线触发：红色 SKU 色源不是火龙果（解析得 %r），中止写入" % face_main)
        params = dict(COMMON_PARAMS)
        params["成品_g"] = list(weight)
        params["色源"] = face_main
        recipes.append({
            "sku_id": sku_id,
            "name": "御字牌五福饺子（%s）（%s）" % (color, filling),
            "color": color,
            "filling": filling,
            "face_main": face_main,
            "main": rec["main"],
            "aux": rec["aux"],
            "seasoning": rec["seasoning"],
            "steps": rec["steps"],
            "params": params,
            "blessing": BLESSING[color],
            "diet_tags": derive_diet_tags(filling, rec["main"], rec["aux"]),
            "version": 1,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        })
        sop.extend(build_sop_steps(sku_id, rec["steps"]))
    if missing:
        log.warning("以下 SKU 在 docx 中未找到对应小节（未入库）: %s", missing)
    return recipes, sop


def ensure_tables(db_path):
    with open(MIGRATION_SQL, "r", encoding="utf-8") as f:
        sql = f.read()
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(sql)
        conn.commit()
    finally:
        conn.close()


def seed(db_path, recipes, sop, dry_run):
    print("== SKU 清单（%d 个）==" % len(recipes))
    for r in recipes:
        print("  %-18s %s | %s | 寓意:%s | 色源:%s | 步骤:%d | 忌口:%s" % (
            r["sku_id"], r["color"], r["filling"], r["blessing"],
            r["face_main"], len(r["steps"]), "/".join(r["diet_tags"])))
    print("sop_steps 共 %d 行" % len(sop))
    if dry_run:
        print("--dry-run：不落库")
        return

    ensure_tables(db_path)
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            for r in recipes:
                conn.execute(
                    "INSERT OR REPLACE INTO recipes"
                    " (sku_id,name,color,filling,face_main,main,aux,seasoning,"
                    "  steps,params,blessing,diet_tags,version,updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (r["sku_id"], r["name"], r["color"], r["filling"], r["face_main"],
                     json.dumps(r["main"], ensure_ascii=False),
                     json.dumps(r["aux"], ensure_ascii=False),
                     json.dumps(r["seasoning"], ensure_ascii=False),
                     json.dumps(r["steps"], ensure_ascii=False),
                     json.dumps(r["params"], ensure_ascii=False),
                     r["blessing"],
                     json.dumps(r["diet_tags"], ensure_ascii=False),
                     r["version"], r["updated_at"]))
            for s in sop:
                conn.execute(
                    "INSERT OR REPLACE INTO sop_steps"
                    " (sku_id,step_no,stage,duration_min,tools,inputs,"
                    "  key_points,qc_point,risk,params)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (s["sku_id"], s["step_no"], s["stage"], s["duration_min"],
                     json.dumps(s["tools"], ensure_ascii=False),
                     json.dumps(s["inputs"], ensure_ascii=False),
                     s["key_points"], s["qc_point"], s["risk"],
                     json.dumps(s["params"], ensure_ascii=False)))
            # 今日示范工单：同日同 SKU 已存在则跳过（幂等）
            today = datetime.now().strftime("%Y-%m-%d")
            demo_sku = recipes[0]["sku_id"] if recipes else SKU_DEFS[0][2]
            exists = conn.execute(
                "SELECT COUNT(*) FROM sop_workorders WHERE date=? AND sku_id=?",
                (today, demo_sku)).fetchone()[0]
            if not exists:
                conn.execute(
                    "INSERT INTO sop_workorders"
                    " (date,sku_id,qty,planned_start,status,qc_records)"
                    " VALUES (?,?,?,?,?,?)",
                    (today, demo_sku, 50, today + "T10:00", "待开始", "[]"))
                log.info("已生成今日示范工单: %s %s qty=50 待开始", today, demo_sku)
            else:
                log.info("今日示范工单已存在，跳过")
        n_r = conn.execute("SELECT COUNT(*) FROM recipes").fetchone()[0]
        n_s = conn.execute("SELECT COUNT(*) FROM sop_steps").fetchone()[0]
        n_w = conn.execute("SELECT COUNT(*) FROM sop_workorders").fetchone()[0]
        print("落库完成: recipes=%d sop_steps=%d sop_workorders=%d (db=%s)"
              % (n_r, n_s, n_w, db_path))
    finally:
        conn.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description="五福饺子配方种子（docx → recipes/sop_steps）")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--docx", default=DEFAULT_DOCX)
    ap.add_argument("--dry-run", action="store_true", help="只打印摘要，不落库")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    if not os.path.exists(args.docx):
        log.error("docx 不存在: %s", args.docx)
        return 1
    recipes, sop = build_recipes(args.docx)
    if not recipes:
        log.error("未解析到任何 SKU，中止")
        return 1
    seed(args.db, recipes, sop, args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
