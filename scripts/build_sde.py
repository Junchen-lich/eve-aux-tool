#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""EVE 辅助工具 —— 静态数据库构建脚本

从 SDE（Static Data Export）构建运行时所需的 JSON 数据表。

用法：
    python3 scripts/build_sde.py --sde <SDE目录或_sde.zip> [--out data/sde]

依赖：仅标准库（YAML 用内置的极简解析器处理 blueprints.yaml）
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")


# ------------------------------------------------------------------ #
# SDE 读取
# ------------------------------------------------------------------ #
class Sde:
    """同时支持目录形式与 zip 形式的 SDE 读取。"""

    def __init__(self, path):
        self.path = path
        self.zf = None
        self.root = None
        if os.path.isfile(path):
            self.zf = zipfile.ZipFile(path)
        elif os.path.isdir(path):
            # 目录模式：优先找 _sde 子目录
            for cand in ("_sde", "sde", "."):
                sub = os.path.join(path, cand)
                if os.path.isdir(sub) and os.path.exists(os.path.join(sub, "invTypes.csv")):
                    self.root = sub
                    break
            if self.root is None:
                self.root = path
        else:
            raise SystemExit("SDE 路径不存在：" + path)

    def read(self, name):
        """读取文本内容，name 为相对路径。

        兼容两种 SDE 布局：
          - 旧版 CSV：invTypes.csv 在根目录
          - 新版 YAML（_sde.zip）：fsd/*.yaml、bsd/*.yaml、universe/*/
        """
        if self.zf is not None:
            for candidate in (name, "fsd/" + name, "bsd/" + name,
                              name.replace(".csv", ".yaml"), "fsd/" + name.replace(".csv", ".yaml")):
                try:
                    return self.zf.read(candidate).decode("utf-8", "ignore")
                except KeyError:
                    continue
            raise KeyError(name)
        for cand in (name, "fsd/" + name, "bsd/" + name):
            full = os.path.join(self.root, cand)
            if os.path.exists(full):
                with io.open(full, "r", encoding="utf-8-sig", errors="ignore") as f:
                    return f.read()
        raise KeyError(name)

    def exists(self, name):
        try:
            self.read(name)
            return True
        except KeyError:
            return False

    def csv_rows(self, name):
        """读取 CSV 为 dict 列表。"""
        text = self.read(name)
        reader = csv.DictReader(io.StringIO(text))
        return list(reader)


# ------------------------------------------------------------------ #
# 极简 YAML 解析（只处理 blueprints.yaml 的结构）
# ------------------------------------------------------------------ #
def parse_blueprints_yaml(text):
    """解析 SDE blueprints.yaml。

    ★ 实际缩进结构（实测自 _sde.zip 的 fsd/blueprints.yaml）：
        681:                          ← 0  蓝图键
          activities:                 ← 2
            manufacturing:            ← 4  活动名
              materials:              ← 6  列表键（值在同级 - 开头的行）
              - quantity: 86          ← 6  列表项（与列表键同缩进！）
                typeID: 38            ← 8  列表项续行
              products:               ← 6
              - quantity: 1           ← 6
                typeID: 165           ← 8
              time: 600               ← 6  标量
            copying:                  ← 4  活动名
              time: 480               ← 6  标量
          blueprintTypeID: 681        ← 2  蓝图级标量
          maxProductionLimit: 300     ← 2

    ★ 关键难点：列表项与其键同缩进（均为 6），无法用缩进区分，
      只能用 "- " 前缀识别。因此「列表键」的判定必须依赖**已知键名**，
      而不是「以冒号结尾」。

    实现方式：先把整段缩进为 6 的行收集起来，
    遇到「已知列表键」（materials/products/skills）则进入列表模式，
    后续同缩进的 "- " 行归入该列表，直到遇到非 "- " 行或缩进变化。
    """
    LIST_KEYS = ("materials", "products", "skills")

    result = {}
    cur_bp = None
    cur_act = None
    cur_list = None      # 当前列表键名
    cur_item = None      # 当前列表项 dict
    pending_list = None  # 已识别但尚未见到首项的列表键

    for raw in text.splitlines():
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()

        # ---- 顶层蓝图键 ----
        if indent == 0 and line.endswith(":") and line[:-1].strip().isdigit():
            cur_bp = {"activities": {}}
            result[line[:-1].strip()] = cur_bp
            cur_act = None
            cur_list = None
            cur_item = None
            pending_list = None
            continue

        if cur_bp is None:
            continue

        # ---- 活动名（缩进 4，必须在蓝图级标量之前）----
        if indent == 4 and line.endswith(":"):
            cur_act = line[:-1].strip()
            cur_bp["activities"][cur_act] = {}
            cur_item = None
            pending_list = None
            continue

        # ---- 蓝图级标量（缩进 2，如 blueprintTypeID / maxProductionLimit）----
        # 注意：必须排除 "activities:" 本身，否则会把 activities 字典覆盖成 None。
        if indent == 2 and ":" in line:
            k, v = line.split(":", 1)
            k = k.strip()
            if k != "activities":
                cur_bp[k] = _cast(v.strip())
                cur_act = None
                cur_item = None
                pending_list = None
            continue

        if cur_act is None:
            continue

        # ---- 列表项（必须先判，因为与列表键同缩进）----
        if line.startswith("- ") and pending_list is not None:
            cur_item = {}
            cur_bp["activities"][cur_act].setdefault(pending_list, []).append(cur_item)
            body = line[2:]
            if ":" in body:
                k, v = body.split(":", 1)
                cur_item[k.strip()] = _cast(v.strip())
            continue

        # ---- 列表项续行（缩进 8）----
        if cur_item is not None and indent >= 8 and ":" in line:
            k, v = line.split(":", 1)
            cur_item[k.strip()] = _cast(v.strip())
            continue

        # ---- 列表键（靠已知键名判定，缩进 6）----
        if indent == 6 and line.endswith(":") and line[:-1].strip() in LIST_KEYS:
            pending_list = line[:-1].strip()
            cur_bp["activities"][cur_act][pending_list] = []
            cur_item = None
            continue

        # ---- 活动内标量（缩进 6）----
        if indent == 6 and ":" in line:
            k, v = line.split(":", 1)
            cur_bp["activities"][cur_act][k.strip()] = _cast(v.strip())
            cur_item = None
            pending_list = None
            continue

    return result


def _cast(v):
    """把 YAML 标量转成 Python 值。"""
    v = v.strip().strip('"').strip("'")
    if v == "":
        return None
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "~"):
        return None
    try:
        if re.fullmatch(r"-?\d+", v):
            return int(v)
        if re.fullmatch(r"-?\d+\.\d+", v):
            return float(v)
    except ValueError:
        pass
    return v


# ------------------------------------------------------------------ #
# 构建各数据表
# ------------------------------------------------------------------ #
def build_item_names(sde, out_dir):
    """物品名表：中文 + 英文 双表。

    中文优先取 SDE 附带的本地化数据（若有），否则用 typeName（英文）。
    中文来源通常由 evedata.xlsx 单独提供 —— 见 build_cn_names.py。
    """
    rows = sde.csv_rows("invTypes.csv")
    en = {}
    for r in rows:
        tid = (r.get("typeID") or "").strip()
        if not tid:
            continue
        name = (r.get("typeName") or "").strip()
        if name:
            en[tid] = name
    dump(out_dir, "item_names_en.json", en)
    return en, len(en)


def build_industry(sde, out_dir):
    """工业活动数据：{ times, mats, prods }。

    活动 ID：1=制造 3=TE研究 4=ME研究 5=拷贝 8=发明 11=反应
    """
    times, mats, prods = {}, {}, {}

    for r in sde.csv_rows("industryActivity.csv"):
        tid = (r.get("typeID") or "").strip()
        act = (r.get("activityID") or "").strip()
        t = (r.get("time") or "").strip()
        if not tid or not act:
            continue
        try:
            times.setdefault(tid, {})[act] = int(float(t))
        except ValueError:
            continue

    for r in sde.csv_rows("industryActivityMaterials.csv"):
        tid = (r.get("typeID") or "").strip()
        act = (r.get("activityID") or "").strip()
        mid = (r.get("materialTypeID") or "").strip()
        qty = (r.get("quantity") or "").strip()
        if not tid or not act or not mid:
            continue
        try:
            mats.setdefault(tid, {}).setdefault(act, []).append([int(mid), int(float(qty))])
        except ValueError:
            continue

    for r in sde.csv_rows("industryActivityProducts.csv"):
        tid = (r.get("typeID") or "").strip()
        act = (r.get("activityID") or "").strip()
        pid = (r.get("productTypeID") or "").strip()
        qty = (r.get("quantity") or "").strip()
        if not tid or not act or not pid:
            continue
        try:
            prods.setdefault(tid, {}).setdefault(act, []).append([int(pid), int(float(qty))])
        except ValueError:
            continue

    data = {"times": times, "mats": mats, "prods": prods}
    dump(out_dir, "industry.json", data)
    return {"times": len(times), "mats": len(mats), "prods": len(prods)}


def build_blueprints(sde, out_dir, zip_path=None):
    """蓝图数据：{ typeID: { product, productQty, materials, activities } }。

    蓝图定义只存在于新版 SDE 的 fsd/blueprints.yaml（CSV 目录中没有），
    因此优先从 zip 读取；若给了 zip_path 则直接用。
    """
    if zip_path and os.path.isfile(zip_path):
        with zipfile.ZipFile(zip_path) as z:
            raw = parse_blueprints_yaml(z.read("fsd/blueprints.yaml").decode("utf-8", "ignore"))
    else:
        raw = parse_blueprints_yaml(sde.read("fsd/blueprints.yaml"))
    ind = json.load(open(os.path.join(out_dir, "industry.json"), encoding="utf-8"))

    out = {}
    for tid, bp in raw.items():
        acts = bp.get("activities", {})
        manu = acts.get("manufacturing") or {}
        mats = [[m.get("typeID"), m.get("quantity")] for m in (manu.get("materials") or [])]
        prods = [[p.get("typeID"), p.get("quantity")] for p in (manu.get("products") or [])]
        product = prods[0][0] if prods else None
        qty = prods[0][1] if prods else 0
        entry = {
            "product": product,
            "productQty": qty or 0,
            "materials": [m for m in mats if m[0] is not None],
            "activities": acts,
            "maxProductionLimit": bp.get("maxProductionLimit"),
        }
        out[tid] = entry
    dump(out_dir, "blueprints.json", out)
    return len(out)


def build_universe(sde, out_dir):
    """宇宙数据：星域 / 星座 / 星系。"""
    regions, constellations, systems = [], [], []

    for r in sde.csv_rows("mapRegions.csv"):
        rid = (r.get("regionID") or "").strip()
        if not rid:
            continue
        regions.append({
            "id": int(rid),
            "name": (r.get("regionName") or "").strip(),
            "constellations": int(float(r.get("constellationIDs") or 0)) if (r.get("constellationIDs") or "").strip().isdigit() else None,
            "security": _safe_float(r.get("regionSecurity")),
        })

    for r in sde.csv_rows("mapConstellations.csv"):
        cid = (r.get("constellationID") or "").strip()
        if not cid:
            continue
        constellations.append({
            "id": int(cid),
            "name": (r.get("constellationName") or "").strip(),
            "region": int(float(r.get("regionID") or 0)),
            "security": _safe_float(r.get("securityStatus")),
        })

    for r in sde.csv_rows("mapSolarSystems.csv"):
        sid = (r.get("solarSystemID") or "").strip()
        if not sid:
            continue
        systems.append({
            "id": int(sid),
            "name": (r.get("solarSystemName") or "").strip(),
            "constellation": int(float(r.get("constellationID") or 0)),
            "region": int(float(r.get("regionID") or 0)),
            "security": _safe_float(r.get("securityStatus")),
            "sec": _safe_float(r.get("securityStatus")),
        })

    data = {"regions": regions, "constellations": constellations, "systems": systems}
    dump(out_dir, "universe.json", data)
    return {"regions": len(regions), "constellations": len(constellations), "systems": len(systems)}


def build_market_groups(sde, out_dir):
    """市场分组树：{ id: { n, p, t } }。"""
    groups = {}
    for r in sde.csv_rows("invMarketGroups.csv"):
        gid = (r.get("marketGroupID") or "").strip()
        if not gid:
            continue
        parent = (r.get("parentMarketGroupID") or "0").strip() or "0"
        icon = (r.get("marketGroupIcon") or "").strip()
        groups[gid] = {"n": icon, "p": int(parent), "t": []}

    # invTypes 提供 typeID → marketGroupID
    for r in sde.csv_rows("invTypes.csv"):
        tid = (r.get("typeID") or "").strip()
        mg = (r.get("marketGroupID") or "").strip()
        if not tid or not mg or mg == "0":
            continue
        if mg in groups:
            groups[mg]["t"].append(int(tid))

    dump(out_dir, "market_groups.json", groups)
    return len(groups)


def build_pi_schematics(sde, out_dir):
    """行星工业配方：{ typeID: { name, cycle, inputs, outputs } }。"""
    schem = {}
    for r in sde.csv_rows("planetSchematics.csv"):
        sid = (r.get("schematicID") or "").strip()
        if not sid:
            continue
        schem[sid] = {
            "name": (r.get("schematicName") or "").strip(),
            "cycle": _safe_int(r.get("cycleTime")),
            "type": (r.get("schematicType") or "").strip(),
        }

    # TypeMap: schematicID → (typeID, quantity)
    inp, outp = {}, {}
    for r in sde.csv_rows("planetSchematicsTypeMap.csv"):
        sid = (r.get("schematicID") or "").strip()
        tid = (r.get("typeID") or "").strip()
        qty = (r.get("quantity") or "").strip()
        if not sid or not tid:
            continue
        try:
            q = int(float(qty))
        except ValueError:
            q = 0
        # outputTypeID 字段存在则为产出
        is_out = (r.get("outputTypeID") or "").strip()
        if is_out:
            outp.setdefault(sid, []).append([int(tid), q])
        else:
            inp.setdefault(sid, []).append([int(tid), q])

    result = {}
    for sid, s in schem.items():
        result[sid] = {
            "name": s["name"],
            "cycle": s["cycle"],
            "inputs": inp.get(sid, []),
            "outputs": outp.get(sid, []),
        }
    dump(out_dir, "pi_schematics.json", result)
    return len(result)


def build_ore_refine(sde, out_dir, en_names):
    """矿石分级与精炼产物。

    ★ 数据来源与识别方法
    矿石级别（如 "Tritanium 1"）**不是 invTypes 条目**，而是「精炼蓝图」的产物。
    识别路径：
      1. 找出所有「单一原料 + 产出数量 > 1」的蓝图 → 这些是精炼蓝图
      2. 精炼蓝图的 **产物** 就是矿石级别（如 Tritanium 1，typeID 100xx）
      3. 精炼蓝图的 **原料** 就是精炼产物（如 Tritanium，typeID 34）
      4. 按英文名去掉数字后缀，聚合成矿石族
    """
    bp = json.load(open(os.path.join(out_dir, "blueprints.json"), encoding="utf-8"))

    # 1) 找出精炼蓝图：单一原料 + 多产物
    refine_bp = {}
    for tid, v in bp.items():
        mats = v.get("materials") or []
        if len(mats) == 1 and (v.get("productQty") or 0) > 1:
            refine_bp[tid] = (mats[0][0], mats[0][1])   # (原料typeID, 原料数量)

    # 2) 矿石级别 = 精炼蓝图的产物 typeID
    #    蓝图 681: 原料 38×86 → 产物 165×1  ← 这是制造，不是精炼
    #    精炼蓝图形如：原料 Tritanium×100 → 产物 "Tritanium 1"×若干
    ore_levels = {}     # 矿石级别 typeID → {原料typeID, 数量}
    for tid, (mat_id, mat_qty) in refine_bp.items():
        prod = bp[tid].get("product")
        prod_name = en_names.get(str(prod), "") if prod else ""
        if not prod_name:
            continue
        # 矿石级别的英文名形如 "Tritanium 1"、"Rubite 3"
        if not re.search(r"\s\d+$", prod_name):
            continue
        ore_levels[prod] = {"material": mat_id, "qty": mat_qty}

    # 3) 按英文名去数字后缀聚合成族
    families = {}
    for ore_id, info in ore_levels.items():
        nm = en_names.get(str(ore_id), "")
        m = re.match(r"^(.*?)\s+(\d+)$", nm)
        if not m:
            continue
        base, level = m.group(1), int(m.group(2))
        families.setdefault(base, []).append({
            "level": level,
            "typeId": ore_id,
            "name": nm,
            "material": info["material"],
            "qty": info["qty"],
        })

    # 4) 组装：每族每级的精炼产物 = 该矿石级别蓝图的所有产物
    result = {}
    for base, levels in families.items():
        levels.sort(key=lambda x: x["level"])
        out_levels = []
        for lv in levels:
            prods = []
            for tid, v in bp.items():
                if (v.get("product") == lv["typeId"]) and (v.get("productQty") or 0) > 1:
                    for mat_id, mat_qty in (v.get("materials") or []):
                        prods.append({
                            "typeId": mat_id,
                            "name": en_names.get(str(mat_id), ""),
                            "qty": mat_qty,
                        })
            out_levels.append({
                "level": lv["level"],
                "typeId": lv["typeId"],
                "name": lv["name"],
                "prods": prods,
            })
        if out_levels:
            result[base] = {"name": base, "levels": out_levels}

    dump(out_dir, "ore_refine.json", result)
    return len(result)


def _safe_float(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def _safe_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def dump(out_dir, name, data):
    full = os.path.join(out_dir, name)
    with io.open(full, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size = os.path.getsize(full)
    print("  %-26s %8.1f KB" % (name, size / 1024))


# ------------------------------------------------------------------ #
def main():
    ap = argparse.ArgumentParser(description="从 SDE 构建 EVE 辅助工具静态数据库")
    ap.add_argument("--sde", required=True, help="SDE 目录（含 CSV）或 _sde.zip")
    ap.add_argument("--zip", dest="zip_path", default=None,
                    help="可选：fsd/blueprints.yaml 所在的 _sde.zip（蓝图只在 YAML 版 SDE 中）")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "sde"),
                    help="输出目录")
    args = ap.parse_args()

    if not os.path.isdir(args.out):
        os.makedirs(args.out)

    print("SDE 来源：%s" % args.sde)
    if args.zip_path:
        print("蓝图来源：%s" % args.zip_path)
    print("输出目录：%s\n" % args.out)

    sde = Sde(args.sde)

    print("构建数据表：")
    en, n = build_item_names(sde, args.out)
    print("  → item_names_en.json      %d 条英文名" % n)

    st = build_industry(sde, args.out)
    print("  → industry.json           times=%d mats=%d prods=%d" % (st["times"], st["mats"], st["prods"]))

    n = build_blueprints(sde, args.out, args.zip_path)
    print("  → blueprints.json         %d 张蓝图" % n)

    st = build_universe(sde, args.out)
    print("  → universe.json           星域=%d 星座=%d 星系=%d" % (st["regions"], st["constellations"], st["systems"]))

    n = build_market_groups(sde, args.out)
    print("  → market_groups.json      %d 个分组" % n)

    n = build_pi_schematics(sde, args.out)
    print("  → pi_schematics.json      %d 个配方" % n)

    n = build_ore_refine(sde, args.out, en)
    print("  → ore_refine.json         %d 个矿石族" % n)

    print("\n完成。中文名表需另行运行 build_cn_names.py（使用官方 evedata.xlsx）。")


if __name__ == "__main__":
    main()
