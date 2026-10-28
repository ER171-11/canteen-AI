# -*- coding: utf-8 -*-
"""
三向合并：base(上次同步的版本) / mine(本机) / theirs(服务端)。

用途
1. 店与家两台机器离线各录数据，再次联网时自动合并，互不覆盖；
2. 网盘产生冲突副本时，用「合并副本.bat」把另一份合进主库。

合并粒度（记录级，不是整库覆盖）
- ings/dishes/pos/sales/quotes 按 id
- logs 按 seq
- rec(配方) 按菜品 id，比较 _recU[菜品id]
- suppliers 取并集；platforms 按 name
- seq/v/rest 等标量：seq 取大，rest 取本机

规则
- 只有一端改 → 用改过的那端
- 两端都改 → 比 _u 时间戳，新的胜出；时间戳相同取服务端，并记入 conflicts
- 一端删除、另一端未改 → 认删；一端删除、另一端改过 → 保留改过的那端
"""
import hashlib
import json

# 集合名 -> 记录唯一键
COLL_KEY = {
    "ings": "id",
    "dishes": "id",
    "pos": "id",
    "sales": "id",
    "quotes": "id",
    "logs": "seq",
    # 云端队列写入的采购/进货必须参与合并，否则入库单与库存重算会在冲突路径丢失
    "orders": "id",
    "recv": "id",
    # 受控词表存 JSON 快照（data.ing_terms），按词条 id 合并
    "ing_terms": "id",
    # 供应商类目受控词表（data.vendor_terms，Phase 2），同样按词条 id 合并，防冲突路径丢词条
    "vendor_terms": "id",
}


def rec_hash(obj):
    """记录指纹：忽略 _u(更新时间) / _d(墓碑)，只比业务内容。"""
    if isinstance(obj, dict):
        clean = {k: v for k, v in obj.items() if k not in ("_u", "_d")}
    else:
        clean = obj
    raw = json.dumps(clean, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _index(rows, key):
    out = {}
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        k = r.get(key)
        if k is None:
            k = rec_hash(r)
        out[str(k)] = r
    return out


def _ts(rec):
    return str((rec or {}).get("_u") or "")


def _order(rows, ref_rows, key):
    """保持服务端原有顺序，新增记录追加在末尾。"""
    pos = {}
    for i, r in enumerate(ref_rows or []):
        if isinstance(r, dict):
            k = r.get(key)
            if k is not None:
                pos[str(k)] = i
    return sorted(
        rows,
        key=lambda r: (pos.get(str(r.get(key)), 10 ** 9), str(r.get(key) or "")),
    )


def merge_list(rows_b, rows_m, rows_t, key, tag, conflicts):
    bm, mm, tm = _index(rows_b, key), _index(rows_m, key), _index(rows_t, key)
    out = []
    for k in set(bm) | set(mm) | set(tm):
        rb, rm, rt = bm.get(k), mm.get(k), tm.get(k)
        hb = rec_hash(rb) if rb is not None else None
        hm = rec_hash(rm) if rm is not None else None
        ht = rec_hash(rt) if rt is not None else None

        if rm is not None and rt is not None:
            if hm == ht:
                chosen = rm
            elif hm == hb:
                chosen = rt                      # 只有对端改
            elif ht == hb:
                chosen = rm                      # 只有本机改
            else:
                um, ut = _ts(rm), _ts(rt)
                if um > ut:
                    chosen = rm
                elif ut > um:
                    chosen = rt
                else:
                    chosen = rt
                    conflicts.append({"coll": tag, "id": k, "reason": "both-changed-same-time"})
        elif rm is not None:                     # 对端没有这条
            if rb is None:                       # 本机新增
                chosen = rm
            elif hm == hb:                       # 本机没改过 -> 认对端删除
                chosen = None
            else:                                # 本机改过、对端删了 -> 保留本机改动
                chosen = rm
                conflicts.append({"coll": tag, "id": k, "reason": "deleted-on-remote"})
        elif rt is not None:                     # 本机没有这条
            if rb is None:                       # 对端新增
                chosen = rt
            elif ht == hb:                       # 对端没改过 -> 认本机删除
                chosen = None
            else:                                # 对端改过、本机删了 -> 保留对端改动
                chosen = rt
                conflicts.append({"coll": tag, "id": k, "reason": "deleted-on-local"})
        else:
            chosen = None

        if chosen is not None:
            out.append(chosen)
    return _order(out, rows_t, key)


def merge_rec(base, mine, theirs, conflicts):
    b = (base or {}).get("rec") or {}
    m = (mine or {}).get("rec") or {}
    t = (theirs or {}).get("rec") or {}
    ub = (base or {}).get("_recU") or {}
    um_ = (mine or {}).get("_recU") or {}
    ut_ = (theirs or {}).get("_recU") or {}

    merged, rec_u = {}, {}
    for did in set(b) | set(m) | set(t):
        rb, rm, rt = b.get(did), m.get(did), t.get(did)
        hb = rec_hash(rb) if rb is not None else None
        hm = rec_hash(rm) if rm is not None else None
        ht = rec_hash(rt) if rt is not None else None

        if rm is not None and rt is not None:
            if hm == ht:
                chosen, ts = rm, max(um_.get(did, ""), ut_.get(did, ""))
            elif hm == hb:
                chosen, ts = rt, ut_.get(did, "")
            elif ht == hb:
                chosen, ts = rm, um_.get(did, "")
            else:
                if um_.get(did, "") >= ut_.get(did, ""):
                    chosen, ts = rm, um_.get(did, "")
                else:
                    chosen, ts = rt, ut_.get(did, "")
                if um_.get(did, "") == ut_.get(did, ""):
                    conflicts.append({"coll": "rec", "id": did, "reason": "both-changed-same-time"})
        elif rm is not None:
            chosen, ts = (None, "") if hm == hb else (rm, um_.get(did, ""))
        elif rt is not None:
            chosen, ts = (None, "") if ht == hb else (rt, ut_.get(did, ""))
        else:
            chosen, ts = None, ""

        if chosen is not None:
            merged[did] = chosen
            if ts:
                rec_u[did] = ts
    return merged, rec_u


def merge_simple(base, mine, theirs, key, conflicts):
    """suppliers(字符串并集) / platforms(按 name) 之类的小集合。"""
    b, m, t = base or [], mine or [], theirs or []
    if key == "name":
        out = {}
        for r in list(b) + list(m) + list(t):
            if isinstance(r, dict):
                out[r.get("name") or rec_hash(r)] = r
        return list(out.values())
    seen, out = set(), []
    for r in list(t) + list(m) + list(b):
        if r is None:
            continue
        k = r if isinstance(r, str) else rec_hash(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def merge(base, mine, theirs):
    """
    返回 (merged_db, conflicts)。
    base/mine/theirs 均为完整 DB 对象(dict)。
    """
    base = base or {}
    mine = mine or {}
    theirs = theirs or {}
    conflicts = []

    out = {}
    out.update(theirs)

    for coll, key in COLL_KEY.items():
        out[coll] = merge_list(
            base.get(coll), mine.get(coll), theirs.get(coll), key, coll, conflicts
        )

    rec_merged, rec_u = merge_rec(base, mine, theirs, conflicts)
    out["rec"] = rec_merged
    if rec_u:
        out["_recU"] = rec_u

    out["suppliers"] = merge_simple(base.get("suppliers"), mine.get("suppliers"),
                                    theirs.get("suppliers"), None, conflicts)
    out["platforms"] = merge_simple(base.get("platforms"), mine.get("platforms"),
                                    theirs.get("platforms"), "name", conflicts)

    out["seq"] = max(int(base.get("seq") or 0), int(mine.get("seq") or 0),
                     int(theirs.get("seq") or 0)) + 1
    out["v"] = max(int(base.get("v") or 0), int(mine.get("v") or 0),
                   int(theirs.get("v") or 0))
    out["rest"] = mine.get("rest") or theirs.get("rest") or base.get("rest")

    # 同步元信息：不参与业务
    for meta in ("_meta", "_recU"):
        if meta == "_recU":
            continue
        if meta in mine or meta in theirs:
            out[meta] = dict(theirs.get(meta) or {})
            out[meta].update(mine.get(meta) or {})

    return out, conflicts
