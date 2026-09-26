#!/usr/bin/env python3
"""补齐财务/能耗等空表，避免管理端空白。"""
import os
import sqlite3
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "data", "餐厅系统.db")


def now():
    return datetime.now().isoformat(timespec="seconds")


def today(off=0):
    return (datetime.now() + timedelta(days=off)).strftime("%Y-%m-%d")


def main():
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    # 发票
    if cur.execute("SELECT COUNT(*) FROM fin_invoices").fetchone()[0] == 0:
        cur.executemany(
            "INSERT INTO fin_invoices (invoice_no, kind, direction, amount, tax, ts, status) VALUES (?,?,?,?,?,?,?)",
            [
                ("FP202609001", "电子普票", "销项", 1280, 72.45, now(), "已开具"),
                ("FP202609002", "专票", "进项", 860, 111.4, now(), "已认证"),
                ("FP202609003", "电子普票", "销项", 560, 31.7, now(), "已开具"),
            ],
        )
        print("fin_invoices seeded")

    # 税务
    if cur.execute("SELECT COUNT(*) FROM fin_tax").fetchone()[0] == 0:
        period = today()[:7]
        cur.executemany(
            "INSERT INTO fin_tax (period, kind, amount, filed_at, status) VALUES (?,?,?,?,?)",
            [
                (period, "增值税", 3200, None, "待申报"),
                (period, "所得税", 1500, None, "待申报"),
                (period, "附加税", 280, today(-5), "已申报"),
            ],
        )
        print("fin_tax seeded")

    # 现金
    if cur.execute("SELECT COUNT(*) FROM fin_cash").fetchone()[0] == 0:
        cur.executemany(
            "INSERT INTO fin_cash (ts, kind, amount, account, note) VALUES (?,?,?,?,?)",
            [
                (now(), "收入", 2300, "收银备用金", "午市"),
                (now(), "支出", 500, "收银备用金", "找零补充"),
                (now(), "存款", 1800, "对公账户", "日结存入"),
            ],
        )
        print("fin_cash seeded")

    # 能耗
    if cur.execute("SELECT COUNT(*) FROM eq_energy").fetchone()[0] == 0:
        cur.executemany(
            "INSERT INTO eq_energy (date, device, kind, reading, usage) VALUES (?,?,?,?,?)",
            [
                (today(), "冷藏柜-1", "电", 12080, 42),
                (today(), "煮饺炉", "气", 880, 12),
                (today(-1), "冷藏柜-1", "电", 12038, 40),
            ],
        )
        print("eq_energy seeded")

    # 冷柜温度时序（真 IoT 推送路径；超温点便于预警验收）
    try:
        if cur.execute("SELECT COUNT(*) FROM eq_temp").fetchone()[0] == 0:
            base = datetime.now()
            rows = []
            for i in range(9):
                ts = (base - timedelta(minutes=(8 - i) * 3)).isoformat(timespec="seconds")
                rows.append((ts, "冷柜 A", 4.0 + i * 0.03))
                rows.append((ts, "冷柜 B", 4.5 + i * 0.35))  # 末段超温
                rows.append((ts, "冷柜 C", 3.6 + (i % 3) * 0.1))
            cur.executemany(
                "INSERT INTO eq_temp (ts, device, temp) VALUES (?,?,?)",
                rows,
            )
            print("eq_temp seeded")
    except sqlite3.OperationalError as e:
        print("eq_temp skip:", e)

    # 证照若缺健康证相关已有；确保 loss 有样例
    if cur.execute("SELECT COUNT(*) FROM loss_reports").fetchone()[0] == 0:
        cur.execute(
            "INSERT INTO loss_reports (date, ing_name, qty, reason, reporter, status) VALUES (?,?,?,?,?,?)",
            (today(), "面粉", 2, "受潮", "admin", "待审核"),
        )
        print("loss_reports seeded")

    conn.commit()
    conn.close()
    print("done", DB)


if __name__ == "__main__":
    main()
