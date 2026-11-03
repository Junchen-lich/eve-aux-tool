#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EVE 辅助工具 —— 中文名与官方数据构建脚本

从官方每日数据包 evedata.xlsx 构建：
  item_names.json    物品中文名表 { typeID: 中文名 }
  stations.json      NPC 空间站
  structures.json    玩家公开建筑
  ore_refine.json    矿石族分级与精炼产物（中文）
  universe_zh.json   宇宙三级中文名（星域/星座/星系）

用法：
    python3 scripts/build_cn_names.py --xlsx <evedata.xlsx> [--out data/sde]

★ 设计原则：后台用英文名（SDE），前台用中文名（官方包），两者以 typeID 相连。
"""
import argparse
import io
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")

from _xlsx_reader import XlsxReader  # noqa: E402


def dump(out_dir, name, data):
    full = os.path.join(out_dir, name)
    with io.open(full, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("  %-26s %8.1f KB" % (name, os.path.getsize(full) / 1024))


def find_sheet(wb, prefix):
    """按前缀匹配工作表名（官方包的中文表名可能带动态后缀）。"""
    for name in wb.sheetnames:
        if name.startswith(prefix):
            return name
    return None


def build_item_names(wb, out_dir):
    """物品中文名表。"""
    sheet = find_sheet(wb, "物品列表")
    if not sheet:
        print("  ! 缺少「物品列表」工作表，跳过 item_names.json")
        return 0
    names = {}
    for row in wb.rows(sheet, min_row=2):
        if not row or row[0] is None:
            continue
        tid = str(row[0]).strip()
        nm = row[1] if len(row) > 1 else None
        if not tid or nm is None:
            continue
        nm = str(nm).strip()
        if nm:
            names[tid] = nm
    dump(out_dir, "item_names.json", names)
    return len(names)


def build_stations(wb, out_dir):
    """NPC 空间站。"""
    sheet = find_sheet(wb, "NPC空间站")
    if not sheet:
        print("  ! 缺少「NPC空间站」工作表，跳过 stations.json")
        return 0
    stations = []
    for row in wb.rows(sheet, min_row=2):
        if not row or row[0] is None:
            continue
        def g(i):
            return row[i] if len(row) > i else None
        stations.append({
            "id": _i(g(0)), "name": _s(g(1)),
            "system": _i(g(2)), "systemName": _s(g(3)),
            "constellation": _i(g(4)), "constellationName": _s(g(5)),
            "region": _i(g(6)), "regionName": _s(g(7)),
        })
    dump(out_dir, "stations.json", {"stations": stations})
    return len(stations)


def build_structures(wb, out_dir):
    """玩家公开建筑。"""
    sheet = find_sheet(wb, "玩家公开建筑")
    if not sheet:
        print("  ! 缺少「玩家公开建筑」工作表，跳过 structures.json")
        return 0
    structures = []
    for row in wb.rows(sheet, min_row=2):
        if not row or row[0] is None:
            continue
        def g(i):
            return row[i] if len(row) > i else None
        structures.append({
            "id": _i(g(0)), "name": _s(g(1)), "type": _s(g(2)),
            "system": _i(g(3)), "systemName": _s(g(4)),
            "constellation": _i(g(5)), "constellationName": _s(g(6)),
            "region": _i(g(7)), "regionName": _s(g(8)),
        })
    dump(out_dir, "structures.json", {"structures": structures})
    return len(structures)


def build_universe_zh(wb, out_dir, en_universe_path):
    """宇宙中文名：把官方包的中文名合并进 SDE 的英文宇宙数据。

    产出 universe.json（含 zh 字段），与 SDE 的结构对齐，
    这样前端既可显示中文，又保留英文名便于排查。
    """
    base = {}
    if os.path.exists(en_universe_path):
        base = json.load(open(en_universe_path, encoding="utf-8"))

    def index(items):
        return {x["id"]: x for x in items}

    regions = index(base.get("regions", []))
    constellations = index(base.get("constellations", []))
    systems = index(base.get("systems", []))

    def apply(sheet, prefix, target, key_field=0):
        if not sheet:
            return 0
        n = 0
        for row in wb.rows(sheet, min_row=2):
            if not row or row[0] is None:
                continue
            rid = _i(row[key_field])
            nm = row[1] if len(row) > 1 else None
            if rid is None or not nm:
                continue
            item = target.get(rid)
            if item is not None:
                item["zh"] = str(nm).strip()
                n += 1
        return n

    n1 = apply(find_sheet(wb, "星域列表"), None, regions)
    n2 = apply(find_sheet(wb, "星座列表"), None, constellations)
    n3 = apply(find_sheet(wb, "星系列表"), None, systems)

    # 补齐官方包有、SDE 无的条目（每日包更新更快时会出现）
    for sheet, bucket, mk in (
        ("星域列表", regions, lambda r: {"id": _i(r[0]), "name": _s(r[1]), "zh": _s(r[1])}),
        ("星座列表", constellations, lambda r: {"id": _i(r[0]), "name": _s(r[1]), "zh": _s(r[1]), "region": _i(r[2])}),
        ("星系列表", systems, lambda r: {"id": _i(r[0]), "name": _s(r[1]), "zh": _s(r[1]), "constellation": _i(r[2]), "region": _i(r[4])}),
    ):
        sh = find_sheet(wb, sheet)
        if not sh:
            continue
        for row in wb.rows(sh, min_row=2):
            if not row or row[0] is None:
                continue
            rid = _i(row[0])
            if rid is None or rid in bucket:
                continue
            bucket[rid] = mk(row)

    data = {
        "regions": list(regions.values()),
        "constellations": list(constellations.values()),
        "systems": list(systems.values()),
    }
    dump(out_dir, "universe.json", data)
    print("       中文名覆盖：星域 %d/%d · 星座 %d/%d · 星系 %d/%d"
          % (n1, len(regions), n2, len(constellations), n3, len(systems)))
    return len(regions) + len(constellations) + len(systems)


def build_ore_refine(wb, out_dir, en_names):
    """矿石族分级与精炼产物（中文）。

    官方包 Sheet3 结构：矿石族 | 级别 | 精炼矿物名 | 每单位数量
    级别本身是「矿石族（ N 级）」，需要反查其 typeID。
    typeID 来源：官方包「物品列表」的 typeID ↔ 中文名对照。
    """
    sheet = find_sheet(wb, "Sheet3")
    if not sheet:
        # 备选：找表头含「矿石族」的表
        for nm in wb.sheetnames:
            rows = list(wb.rows(nm, min_row=1))
            if rows and rows[0] and "矿石族" in str(rows[0][0]):
                sheet = nm
                break
    if not sheet:
        print("  ! 缺少矿石表（Sheet3），跳过 ore_refine.json")
        return 0

    # typeID ↔ 中文名
    tid_by_name = {}
    names = {}
    item_sheet = find_sheet(wb, "物品列表")
    if item_sheet:
        for row in wb.rows(item_sheet, min_row=2):
            if not row or row[0] is None:
                continue
            tid = str(row[0]).strip()
            nm = row[1] if len(row) > 1 else None
            if tid and nm:
                names[tid] = str(nm).strip()
                tid_by_name.setdefault(str(nm).strip(), tid)

    # 收集：矿石族 → 级别 → 精炼产物列表
    fams = {}
    for row in wb.rows(sheet, min_row=2):
        if not row or row[0] is None:
            continue
        fam = row[0]
        lvl = row[1] if len(row) > 1 else None
        prod = row[2] if len(row) > 2 else None
        qty = row[3] if len(row) > 3 else None
        if not fam or not lvl or not prod:
            continue
        fam = str(fam).strip()
        lvl = str(lvl).strip()
        prod = str(prod).strip()
        try:
            q = float(qty)
        except (TypeError, ValueError):
            q = 0
        level = int(re.sub(r"\D", "", lvl) or 0)
        # 级别物品名：矿石族 + （N级）
        lvl_item_name = "%s（%d级）" % (fam, level)
        entry = fams.setdefault(fam, {}).setdefault(level, {
            "level": level,
            "name": lvl_item_name,
            "typeid": int(tid_by_name[lvl_item_name]) if lvl_item_name in tid_by_name else None,
            "prods": [],
        })
        entry["prods"].append({
            "name": prod,
            "typeid": int(tid_by_name[prod]) if prod in tid_by_name else None,
            "qty": q,
        })

    result = {}
    for fam, levels in fams.items():
        arr = []
        for lv in sorted(levels.keys()):
            e = levels[lv]
            # 级别名也可能直接是矿石族本身（1 级）
            if e["typeid"] is None:
                if fam in tid_by_name:
                    e["typeid"] = int(tid_by_name[fam])
                    e["name"] = fam
            arr.append(e)
        result[fam] = {"name": fam, "levels": arr}

    dump(out_dir, "ore_refine.json", result)
    return len(result)


def _s(v):
    return str(v).strip() if v not in (None, "") else ""


def _i(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser(description="从官方 evedata.xlsx 构建中文名数据")
    ap.add_argument("--xlsx", required=True, help="evedata.xlsx 路径")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "sde"))
    args = ap.parse_args()

    if not os.path.isdir(args.out):
        os.makedirs(args.out)

    print("官方包：%s" % args.xlsx)
    print("输出目录：%s\n" % args.out)

    wb = XlsxReader(args.xlsx)
    print("工作表：%s\n" % ", ".join(wb.sheetnames))
    print("构建数据表：")

    n = build_item_names(wb, args.out)
    print("  → item_names.json         %d 条中文名" % n)

    n = build_universe_zh(wb, args.out, os.path.join(args.out, "universe.json"))
    print("  → universe.json           %d 个天体（含中文名）" % n)

    n = build_stations(wb, args.out)
    print("  → stations.json           %d 个空间站" % n)

    n = build_structures(wb, args.out)
    print("  → structures.json         %d 个公开建筑" % n)

    n = build_ore_refine(wb, args.out, {})
    print("  → ore_refine.json         %d 个矿石族" % n)

    wb.close()
    print("\n完成。")


if __name__ == "__main__":
    main()
