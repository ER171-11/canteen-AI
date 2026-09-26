#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
熊猫五福餐厅 · 模块种子脚本（员工/食安/预订排队）（增量组件，核心零改动）

数据来源：../docs 之外的 ../熊猫五福App原型.html 静态演示数据（人工核对提取，
逐条标注出处行号于注释）。所有种子行 source='demo_proto'，
真实业务录入后按 source 标记整体替换。

幂等策略：每次执行先 DELETE WHERE source='demo_proto' 再 INSERT，
重复执行结果一致（只清自己种的演示行，不动任何真实数据）。

写入表（Sprint 0 建表 + migrations/002_seed_align.sql 增补列，仅增不改）：
  staff_shifts / staff_clock / staff_perf / staff_train
  fs_certs / fs_trace / fs_samples / fs_disinfect
  bookings / queue

红线：只写上述新表，绝不触碰 docs/snapshots 主数据与受保护 HTML。
原型里找不到的字段一律留空（NULL），不编造。

用法：
  python3 seed_modules.py --dry-run   # 只打印摘要
  python3 seed_modules.py             # 落库（可重复执行）
  python3 seed_modules.py --db 路径
"""

import argparse
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DB = os.path.join(BASE_DIR, "data", "餐厅系统.db")
MIGRATION_001 = os.path.join(BASE_DIR, "migrations", "001_new_tables.sql")
MIGRATION_002 = os.path.join(BASE_DIR, "migrations", "002_seed_align.sql")

SRC = "demo_proto"
log = logging.getLogger("seed_modules")

TODAY = datetime.now().strftime("%Y-%m-%d")

# 员工工号映射（原型只有姓名，工号为本脚本约定，真实录入后替换）
STAFF = [
    ("ST01", "宋师傅", "厨师"),
    ("ST02", "李厨师长", "厨师长"),
    ("ST03", "王师傅", "厨师"),
    ("ST04", "张师傅", "厨师"),
    ("ST05", "赵店长", "店长"),
    ("ST06", "钱收银", "收银"),
]
STAFF_ID = {n: i for i, n, _ in STAFF}
STAFF_ROLE = {n: r for _, n, r in STAFF}

# 班次代码 → 时间（任务书给定：A早9-17 / B中11-21 / C晚14-23）
SHIFT_TIME = {"A": ("09:00", "17:00"), "B": ("11:00", "21:00"), "C": ("14:00", "23:00")}
SHIFT_NAME = {"A": "早班", "B": "中班", "C": "晚班", "休": "休息", "假": "请假"}

# 排班周：以本周一为起点（相对 TODAY），避免钉死 9.22
def _monday_of(d: datetime) -> datetime:
    return d - timedelta(days=d.weekday())


WEEK_START = _monday_of(datetime.now()).strftime("%Y-%m-%d")
# 原型 1161-1166 行：周一至周日班次（模式保留，日期跟当前周）
WEEK_SHIFTS = {
    "宋师傅":  ["A", "A", "A", "A", "A", "A", "休"],
    "李厨师长": ["A", "A", "B", "A", "A", "A", "休"],
    "王师傅":  ["B", "B", "A", "B", "B", "休", "A"],
    "张师傅":  ["C", "C", "C", "C", "休", "C", "C"],
    "赵店长":  ["A", "A", "A", "A", "A", "A", "休"],
    "钱收银":  ["B", "B", "B", "B", "休", "B", "B"],
}

# 原型 1191-1195 行「打卡明细」（今日）：张师傅「待打卡」无打卡时间，不生成记录（不编造）
CLOCK_ROWS = [
    # (姓名, 打卡时间, kind, status)
    ("宋师傅", "08:58", "上班", "准点"),
    ("李厨师长", "09:02", "上班", "准点"),
    ("王师傅", "11:12", "上班", "迟到"),   # 应 11:00，原型 1193 行
    ("赵店长", "09:05", "上班", "准点"),
]

# 原型 1203-1207 行「绩效 TOP5」；工时取自 1172-1177 行工时条（h）
PERF_ROWS = [
    # (姓名, score, 产出份数[无则 None], hours, remark[原型原文])
    ("李厨师长", 98.5, 412, 45, "出品 412 份 · 废品 1.2%"),
    ("宋师傅",  96.8, 386, 48, "出品 386 份 · 配方 100%"),
    ("赵店长",  95.2, None, 48, "服务 0 差评 · 翻台 3.4"),
    ("张师傅",  91.0, 298, 44, "出品 298 份 · 废品 2.1%"),
    ("钱收银",  90.5, None, 42, "实收 0 差错 · 储值 +¥3.8k"),
]

# 原型 1220-1223 行「培训进度」+ 948/950 行；进度写入 remark
TRAIN_ROWS = [
    # (姓名, course, passed, remark)
    ("李厨师长", "红饺 SOP", 1, "已通过 5/5"),
    ("王师傅", "黑饺 SOP", 0, "进行中 3/5"),
    (None, "新人入职培训", 0, "2 人待考"),       # 原型未署名
    (None, "食安知识考核", 1, "6/6 通过"),
]
# 健康证到期（原型 1227-1229 行）→ 同时记入 fs_certs 与 staff_train（course=健康证）
HEALTH_CERTS = [
    ("王师傅", "2026-10-22"),
    ("张师傅", "2026-10-19"),
    ("钱收银", "2026-10-15"),
]

# 店铺证照（原型 1493-1496 行）；证号/发证日原型未给 → 留空
SHOP_CERTS = [
    ("营业执照", "2027-12-31", "有效"),
    ("食品经营许可证", "2027-06-30", "有效"),
    ("消防安全证", "2028-03-15", "有效"),
    ("环保备案", "2026-11-30", "待续"),
]

# 溯源批次（原型 1507-1509 行）；收货日相对 TODAY，避免钉死旧日期
def _d(offset: int) -> str:
    return (datetime.now() + timedelta(days=offset)).strftime("%Y-%m-%d")


TRACE_ROWS = [
    ("B" + _d(-1).replace("-", "")[4:], "黑猪前肩肉", "张记", _d(-1), "合格"),
    ("M" + _d(-3).replace("-", "")[4:], "食用墨鱼汁", "海南食品", _d(-3), "合格"),
    ("H" + _d(-2).replace("-", "")[4:], "火龙果汁", "菜篮子", _d(-2), "合格"),
]

# 留样：今日午餐出品（48h 到期由 kept_at +48h 推导）
SAMPLE_ROWS = [
    ("红色·长寿饺", 125, TODAY + " 11:30", "午餐"),
    ("黑色·三鲜饺", 130, TODAY + " 11:35", "午餐"),
    ("御膳狮子头", 200, TODAY + " 12:00", "午餐"),
]

# 消毒：今日晨检 + 昨晚紫外
DISINFECT_ROWS = [
    ("餐具消毒柜", None, TODAY + " 09:30", "已完成"),
    ("砧板刀具", None, TODAY + " 10:00", "已完成"),
    ("操作台紫外线", "紫外", _d(-1) + " 22:00", "已完成"),
    ("餐厅地面", None, TODAY + " 14:00", "待执行"),
]

# 今日预订：对齐原型「12 桌 / 38 人」，桌号与 pos_tables T1–T8 对齐
BOOKING_ROWS = [
    ("11:00", "刘姐", 2, "136****2201", "T1", "已确认"),
    ("11:30", "王总", 4, "138****1234", "T5", "已确认"),
    ("11:45", "周女士", 3, "135****8812", "T3", "已确认"),
    ("12:00", "李姐", 3, "139****5678", "T2", "已确认"),
    ("12:15", "孙先生", 4, "137****4410", "T6", "已确认"),
    ("12:30", "吴女士", 2, "136****9022", "T4", "已确认"),
    ("17:30", "郑总", 8, "138****3300", "T7", "已确认"),
    ("18:00", "何女士", 4, "139****1108", "T5", "已确认"),
    ("18:30", "张先生", 6, "137****9012", "T8", "已确认"),
    ("19:00", "陈女士", 2, "136****3456", "T1", "待确认"),
    ("19:15", "马先生", 3, "135****7788", "T3", "已确认"),
    ("19:30", "赵先生", 3, "135****7890", "T6", "已确认"),
]

# 当前排队（原型 1448-1452：叫号 A08）
QUEUE_ROWS = [
    ("A05", 2, "已入座"),
    ("A06", 4, "已入座"),
    ("A07", 3, "就座中"),
    ("A08", 2, "叫号中"),
    ("A09", 4, "等位"),
]


def week_dates():
    d0 = datetime.strptime(WEEK_START, "%Y-%m-%d")
    return [(d0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]


def plus_48h(ts):
    return (datetime.strptime(ts, "%Y-%m-%d %H:%M") + timedelta(hours=48)).strftime("%Y-%m-%d %H:%M")


def build_rows():
    """组装全部种子行，返回 {表名: (列名列表, 行列表)}。"""
    dates = week_dates()
    tables = {}

    rows = []
    for name, shifts in WEEK_SHIFTS.items():
        for d, code in zip(dates, shifts):
            st, et = SHIFT_TIME.get(code, (None, None))
            rows.append((STAFF_ID[name], name, d, SHIFT_NAME.get(code, code),
                         st, et, STAFF_ROLE[name], SRC))
    tables["staff_shifts"] = (
        ("staff_id", "staff_name", "date", "shift", "start_time", "end_time", "role", "source"), rows)

    rows = [(STAFF_ID[n], "%s %s" % (TODAY, t), k, None, st, SRC)
            for n, t, k, st in CLOCK_ROWS]
    tables["staff_clock"] = (("staff_id", "ts", "kind", "device", "status", "source"), rows)

    rows = [(STAFF_ID[n], "", "综合绩效", val, score, remark, hours, SRC)
            for n, score, val, hours, remark in PERF_ROWS]
    tables["staff_perf"] = (
        ("staff_id", "period", "metric", "value", "score", "remark", "hours", "source"), rows)

    rows = [(STAFF_ID.get(n), c, p, TODAY, r, SRC) for n, c, p, r in TRAIN_ROWS]
    rows += [(STAFF_ID[n], "健康证", 0, TODAY, "健康证 %s 到期" % exp, SRC)
             for n, exp in HEALTH_CERTS]
    tables["staff_train"] = (("staff_id", "course", "passed", "ts", "remark", "source"), rows)

    rows = [("健康证", n, None, None, exp, "预警", SRC) for n, exp in HEALTH_CERTS]
    rows += [(t, "熊猫五福餐厅", None, None, exp, st, SRC) for t, exp, st in SHOP_CERTS]
    tables["fs_certs"] = (
        ("cert_type", "holder", "cert_no", "issued_at", "expire_at", "status", "source"), rows)

    rows = [(b, ing, sup, rd, None, None, cr, SRC) for b, ing, sup, rd, cr in TRACE_ROWS]
    tables["fs_trace"] = (
        ("batch_no", "ing_name", "supplier", "recv_date", "origin", "cert_no",
         "check_result", "source"), rows)

    rows = [(TODAY, meal, dish, w, None, kept, plus_48h(kept), SRC)
            for dish, w, kept, meal in SAMPLE_ROWS]
    tables["fs_samples"] = (
        ("date", "meal", "dish", "weight_g", "keeper", "kept_at", "cleared_at", "source"), rows)

    rows = [(TODAY, area, m, None, ts, res, SRC) for area, m, ts, res in DISINFECT_ROWS]
    tables["fs_disinfect"] = (
        ("date", "area", "method", "operator", "ts", "result", "source"), rows)

    rows = [(n, p, TODAY, t, ps, tbl, st, None, SRC)
            for t, n, ps, p, tbl, st in BOOKING_ROWS]
    tables["bookings"] = (
        ("guest_name", "phone", "date", "time", "party_size", "table_id",
         "status", "note", "source"), rows)

    rows = [(no, TODAY, ps, st, None, SRC) for no, ps, st in QUEUE_ROWS]
    tables["queue"] = (("queue_no", "date", "party_size", "status", "ts", "source"), rows)

    return tables


def ensure_schema(db_path):
    """001 全量 IF NOT EXISTS；002 的 ADD COLUMN 逐条做 PRAGMA 检查后执行（幂等）。"""
    conn = sqlite3.connect(db_path)
    try:
        with open(MIGRATION_001, encoding="utf-8") as f:
            conn.executescript(f.read())
        conn.commit()
        with open(MIGRATION_002, encoding="utf-8") as f:
            sql = f.read()
        for m in re.finditer(
                r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)([^;]*);", sql, re.I):
            table, col, decl = m.group(1), m.group(2), m.group(3)
            cols = [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]
            if col not in cols:
                conn.execute("ALTER TABLE %s ADD COLUMN %s%s" % (table, col, decl))
                log.info("补列: %s.%s", table, col)
        conn.commit()
    finally:
        conn.close()


def seed(db_path, tables, dry_run):
    print("== 模块种子摘要（source=%s）==" % SRC)
    for t, (cols, rows) in tables.items():
        print("  %-14s %d 行" % (t, len(rows)))
    if dry_run:
        print("--dry-run：不落库")
        return
    ensure_schema(db_path)
    conn = sqlite3.connect(db_path)
    try:
        with conn:
            for t, (cols, rows) in tables.items():
                conn.execute("DELETE FROM %s WHERE source=?" % t, (SRC,))
                ph = ",".join("?" * len(cols))
                conn.executemany(
                    "INSERT INTO %s (%s) VALUES (%s)" % (t, ",".join(cols), ph), rows)
        for t in tables:
            n = conn.execute("SELECT COUNT(*) FROM %s WHERE source=?" % t, (SRC,)).fetchone()[0]
            log.info("%s: demo_proto %d 行", t, n)
        print("落库完成（db=%s）" % db_path)
    finally:
        conn.close()


def main(argv=None):
    ap = argparse.ArgumentParser(description="模块种子（员工/食安/预订排队，原型演示数据）")
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    tables = build_rows()
    seed(args.db, tables, args.dry_run)
    if not args.dry_run:
        try:
            import seed_finance_extra as sfe
            sfe.main()
        except Exception as exc:  # noqa: BLE001
            log.warning("seed_finance_extra 跳过: %s", exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
