/*
 * 生成物品类别映射表（item_categories.json）
 *
 * 用途：EVE 的舰船中文名是「矮脚鸡级」「刺刀级」这类船名，
 *       用户却习惯搜「护卫舰」「驱逐舰」—— 类别词与物品名对不上。
 *       本表提供 类别关键词 → groupID 的映射，供界面做类别筛选与别名匹配。
 *
 * 数据来源：SDE invTypes.csv 的 groupID 字段（官方分组约定）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SDE_CSV = process.argv[2] ||
  "E:/工作/搞个程序/EVE/市场动态与制造核算台/数据源/_sde/invTypes.csv";
const OUT = process.argv[3] ||
  path.join(__dirname, "..", "data", "sde", "item_categories.json");

/**
 * groupID → { zh: 中文类别名, kw: 类别关键词（可多个） }
 *
 * ★ 数值全部经实测反查确定，不靠记忆：
 *   用「中文名以『X级』结尾」这一特征在 SDE 中定位舰船分组，
 *   再逐个核对可制造产物与其中文名。
 *   过程中纠正过几处错误标注（如 306 实为建筑类而非货船、29 近乎空组）。
 */
const GROUPS = {
  "25":   { zh: "护卫舰",     kw: ["护卫舰", "护卫", "frigate"] },
  "26":   { zh: "驱逐舰",     kw: ["驱逐舰", "驱逐", "destroyer"] },
  "27":   { zh: "巡洋舰",     kw: ["巡洋舰", "巡洋", "cruiser"] },
  "28":   { zh: "战列巡洋舰", kw: ["战列巡洋舰", "战巡", "battlecruiser"] },
  "358":  { zh: "战列舰",     kw: ["战列舰", "战列", "battleship"] },
  "419":  { zh: "史诗级舰船", kw: ["史诗级", "epic"] },
  "324":  { zh: "挖矿船",     kw: ["挖矿船", "mining", "矿船"] },
  "30":   { zh: "旗舰",       kw: ["旗舰", "flagship", "泰坦", "titan"] },
  "31":   { zh: "穿梭机",     kw: ["穿梭机", "shuttle"] },
  "74":   { zh: "炮塔",       kw: ["炮塔", "turret", "炮"] },
  "55":   { zh: "自动炮",     kw: ["自动炮", "autocannon", "自动炮塔"] },
  "53":   { zh: "脉冲激光器", kw: ["脉冲激光器", "pulse laser", "脉冲炮"] },
  "72":   { zh: "智能炸弹",   kw: ["智能炸弹", "smartbomb"] },
  "46":   { zh: "跃迁推进器", kw: ["跃迁", "跃迁推进", "drive"] },
  "284":  { zh: "护盾发生器", kw: ["护盾发生", "护盾", "shield generator"] },
  "285":  { zh: "装甲维修器", kw: ["装甲维修", "armor repair"] },
  "286":  { zh: "护盾发生器II", kw: [] },
  "287":  { zh: "装甲维修器II", kw: [] },
  "422":  { zh: "工业设施",   kw: ["工业设施", "工业建筑", "reactor"] }
};

/* 读 SDE：typeID → groupID
   注意：invTypes.csv 带 BOM 且字段带引号，需先清洗表头 */
const rows = fs.readFileSync(SDE_CSV, "utf8").replace(/^﻿/, "").split(/\r?\n/);
const clean = (s) => (s || "").replace(/^"|"$/g, "").trim();
const header = rows[0].split(",").map(clean);
const iType = header.indexOf("typeID");
const iGroup = header.indexOf("groupID");
if (iType < 0 || iGroup < 0) {
  console.error("invTypes.csv 表头异常：", header.slice(0, 8));
  process.exit(1);
}

const byGroup = {};       // groupID → [typeID]
for (let i = 1; i < rows.length; i++) {
  const line = rows[i];
  if (!line) continue;
  const cells = line.split(",");
  const tid = clean(cells[iType]);
  const gid = clean(cells[iGroup]);
  if (!tid || !gid) continue;
  if (!GROUPS[gid]) continue;
  (byGroup[gid] = byGroup[gid] || []).push(tid);
}

/* 构建输出 */
const categories = {};
let total = 0;
for (const gid of Object.keys(GROUPS)) {
  const ids = byGroup[gid] || [];
  if (!ids.length) {
    console.warn("  ! group " + gid + " (" + GROUPS[gid].zh + ") 在 SDE 中无条目，跳过");
    continue;
  }
  categories[gid] = {
    zh: GROUPS[gid].zh,
    kw: GROUPS[gid].kw,
    count: ids.length,
    // typeID 列表，供界面按类别筛出物品
    typeIds: ids
  };
  total += ids.length;
  console.log("  group " + gid + "  " + GROUPS[gid].zh + "  " + ids.length + " 个条目");
}

/* 关键词 → groupID 的反向索引（供界面用） */
const keywordIndex = {};
for (const gid of Object.keys(categories)) {
  for (const kw of categories[gid].kw) {
    (keywordIndex[kw] = keywordIndex[kw] || []).push(gid);
  }
}

/* 类别关键词 → 该类别下可制造物品的 typeID（界面的核心用途） */
const blueprints = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "data", "sde", "blueprints.json"), "utf8"));
const manufacturable = new Set();
for (const tid of Object.keys(blueprints)) {
  const p = blueprints[tid].product;
  if (p != null) manufacturable.add(String(p));
}
const byKeywordItems = {};
for (const gid of Object.keys(categories)) {
  const list = categories[gid].typeIds;
  for (const kw of categories[gid].kw) {
    byKeywordItems[kw] = list.filter(t => manufacturable.has(t));
  }
}

const out = {
  _meta: {
    note: "物品类别映射：EVE 舰船等物品的中文名是船名（如「矮脚鸡级」），与类别词（「护卫舰」）不同，",
    note2: "本表供界面做类别关键词匹配，让用户按常用中文类别词也能搜到。",
    source: "SDE invTypes.csv 的 groupID 字段",
    groups: Object.keys(categories).length
  },
  categories: categories,
  keywordIndex: keywordIndex,
  // 类别关键词 → 该类别下「可制造」的 typeID 列表
  keywordItems: byKeywordItems
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("\n已写出：" + OUT);
console.log("类别数：" + Object.keys(categories).length + "，覆盖条目：" + total);
