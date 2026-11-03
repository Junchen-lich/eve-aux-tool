/*
 * EVE 辅助工具 —— 数据层自检
 * 运行：node src/data/store.test.js
 *
 * 验证重点：
 *   1. 后台英文名匹配可用（跨服稳定）
 *   2. 前台中文名显示可用，且有回退链
 *   3. 技能映射两端一致（英文 ↔ typeID ↔ 中文）
 *   4. 蓝图/工业/宇宙数据可用
 */
"use strict";

const { store } = require("./store.js");
const SM = require("../core/skill-map.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

console.log("EVE 辅助工具 · 数据层自检");

/* ---------------- 数据表加载 ---------------- */
section("【数据表加载】");
const stats = store.stats();
ok(stats.length >= 8, "已加载数据表", stats.length + " 张");
for (const s of stats) {
  console.log("       %-16s %8.1f KB  条目 %s" % (s.file, s.bytes / 1024, s.count));
}

/* ---------------- 后台英文名匹配 ---------------- */
section("【后台英文名匹配】");
ok(store.englishName(34) === "Tritanium", "typeID 34 → 英文名", store.englishName(34));
ok(store.englishName(3380) === "Industry", "typeID 3380 → Industry", store.englishName(3380));
ok(store.typeIdByEnglishName("Metallurgy") === 3409, "英文名 Metallurgy → typeID 3409");
ok(store.typeIdByEnglishName("Tritanium") === 34, "英文名 Tritanium → typeID 34");
ok(store.typeIdByEnglishName("不存在的物品名XYZ") === null, "未知英文名返回 null");

/* ---------------- 前台中文名显示 ---------------- */
section("【前台中文名显示】");
const r34 = store.resolve(34);
ok(r34.nameZh === "三钛合金", "typeID 34 → 中文名", r34.nameZh);
ok(r34.display === "三钛合金", "display 优先中文", r34.display);
ok(r34.hasZh === true, "hasZh 标记正确");

const rIndustry = store.resolve(3380);
ok(rIndustry.nameZh === "工业理论", "技能 typeID 3380 → 中文名", rIndustry.nameZh);

section("【显示回退链】");
// 165 = Clone Grade Beta（官方包无中文名，SDE 有英文名）
const r165 = store.resolve(165);
ok(r165.nameZh === null, "typeID 165 无中文名", "null");
ok(r165.nameEn === "Clone Grade Beta", "typeID 165 有英文名", r165.nameEn);
ok(r165.display === "Clone Grade Beta", "回退到英文名", r165.display);
ok(!/\d{4,}/.test(r165.display), "回退显示不含 typeID");

// 不存在的 typeID
const rBad = store.resolve(99999999);
ok(rBad.display === "未收录物品", "完全未知 → 兜底文案", rBad.display);
ok(!rBad.display.includes("99999999"), "兜底文案不含 typeID");

section("【覆盖率统计】");
const bp = store.blueprints();
const need = new Set();
for (const k of Object.keys(bp)) {
  need.add(String(k));
  for (const m of (bp[k].materials || [])) need.add(String(m[0]));
  if (bp[k].product) need.add(String(bp[k].product));
}
let zhHit = 0, enOnly = 0, none = 0;
for (const t of need) {
  if (store.chineseName(t)) zhHit++;
  else if (store.englishName(t)) enOnly++;
  else none++;
}
console.log("       蓝图涉及 typeID %d：有中文 %d / 仅英文 %d / 两者皆无 %d"
  .replace("%d", need.size).replace("%d", zhHit).replace("%d", enOnly).replace("%d", none));
ok(zhHit / need.size > 0.8, "中文名覆盖率 > 80%", (100 * zhHit / need.size).toFixed(1) + "%");
ok(zhHit + enOnly === need.size - none, "回退链覆盖全部可命名项");

/* ---------------- 技能映射 ---------------- */
section("【技能映射：英文 ↔ typeID ↔ 中文】");
ok(SM.byTypeId(3380) && SM.byTypeId(3380).nameZh === "工业理论",
  "typeID 3380 → 工业理论");
ok(SM.byTypeId(3409) && SM.byTypeId(3409).nameZh === "冶金学",
  "typeID 3409 → 冶金学");
ok(SM.byTypeId(16622) && SM.byTypeId(16622).nameZh === "会计学",
  "typeID 16622 → 会计学");
ok(SM.byEnglishName("Industry") && SM.byEnglishName("Industry").id === "ind",
  "英文名 Industry → 内部 id ind");
ok(SM.byEnglishName("Refining") && SM.byEnglishName("Refining").id === "refine",
  "别名 Refining → refine（兼容旧称）");
ok(SM.byEnglishName("Reprocessing") && SM.byEnglishName("Reprocessing").id === "refine",
  "官方名 Reprocessing（提炼学概论）→ refine");
ok(SM.byEnglishName("Reprocessing Efficiency") && SM.byEnglishName("Reprocessing Efficiency").id === "refining",
  "官方名 Reprocessing Efficiency（提炼效率理论）→ refining");
ok(SM.byEnglishName("industry") && SM.byEnglishName("industry").id === "ind",
  "英文名大小写不敏感");

section("【技能前端展示为中文】");
const dl = SM.displayList();
ok(dl.length >= 11, "技能列表条数", dl.length + " 条");
ok(dl.every(s => s.name && !/^[A-Za-z ]+$/.test(s.name)),
  "展示名全为中文", dl.slice(0, 3).map(s => s.name).join(" / "));
ok(dl.every(s => s.nameEn), "每项保留英文名（后台用）");

const groups = SM.displayGroups();
ok(Object.keys(groups).length >= 4, "技能分组（中文分组名）", Object.keys(groups).join(" / "));

section("【ESI 技能响应解析】");
const fake = {
  skills: [
    { skill_id: 3380, level: 5 },
    { skill_id: 3409, level: 4 },
    { skill_id: 16622, level: 3 },
    { skill_id: 99999999, level: 1 }
  ]
};
const parsed = SM.parseEsiSkills(fake);
ok(parsed.total === 4, "解析总数", parsed.total);
ok(parsed.levels.ind === 5, "ind=5");
ok(parsed.levels.metal === 4, "metal=4");
ok(parsed.levels.acct === 3, "acct=3");
ok(parsed.unmatched.length === 1, "未识别项单独归集", parsed.unmatched[0].skill_id);

section("【技能 typeID 与本地英文表一致】");
let mismatch = 0;
for (const s of SM.SKILL_TABLE) {
  if (s.typeId == null) continue;
  const local = store.englishName(s.typeId);
  if (!local) { mismatch++; console.log("       ! 本地表缺 typeID " + s.typeId + " (" + s.nameEn + ")"); }
  else if (local.toLowerCase() !== s.nameEn.toLowerCase()) {
    mismatch++;
    console.log("       ! typeID " + s.typeId + " 本地表=" + local + " 技能表=" + s.nameEn);
  }
}
ok(mismatch === 0, "技能 typeID 与 SDE 英文表完全一致", mismatch === 0 ? "全部匹配" : mismatch + " 处不一致");

/* ---------------- 其他数据表 ---------------- */
section("【其他数据表可用性】");
const uni = store.universe();
ok(uni.regions.length > 100, "星域", uni.regions.length + " 个");
ok(uni.systems.length > 8000, "星系", uni.systems.length + " 个");
const withZh = uni.systems.filter(s => s.zh).length;
ok(withZh / uni.systems.length > 0.95, "星系中文名覆盖",
  (100 * withZh / uni.systems.length).toFixed(1) + "%");
const sys = uni.systems.find(s => s.zh);
ok(sys && sys.name && sys.zh, "星系含英文名+中文名", sys ? sys.name + " / " + sys.zh : "");

const ind = store.industry();
ok(ind.times && Object.keys(ind.times).length > 5000, "工业耗时表", Object.keys(ind.times).length + " 条");
ok(ind.times["681"] && ind.times["681"]["1"], "蓝图 681 制造耗时", ind.times["681"]["1"] + " 秒");

const mg = store.marketGroups();
ok(Object.keys(mg).length > 2000, "市场分组", Object.keys(mg).length + " 个");

const ore = store.oreRefine();
ok(Object.keys(ore).length > 30, "矿石族", Object.keys(ore).length + " 族");
const firstOre = Object.values(ore)[0];
ok(firstOre.levels.length > 0 && firstOre.levels[0].prods.length > 0, "矿石精炼产物",
  firstOre.name + " L1 → " + firstOre.levels[0].prods.length + " 种");

const st = store.stations();
ok(st.stations.length > 5000, "NPC 空间站", st.stations.length + " 个");

const bpv = store.blueprints();
ok(Object.keys(bpv).length > 4800, "蓝图", Object.keys(bpv).length + " 张");
const withMats = Object.values(bpv).filter(v => (v.materials || []).length > 0).length;
ok(withMats / Object.keys(bpv).length > 0.9, "蓝图含材料比例",
  (100 * withMats / Object.keys(bpv).length).toFixed(1) + "%");
const bp681 = bpv["681"];
ok(bp681 && bp681.product === 165 && bp681.materials.length === 1, "蓝图 681 结构正确",
  JSON.stringify({ product: bp681.product, mats: bp681.materials }));

console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
