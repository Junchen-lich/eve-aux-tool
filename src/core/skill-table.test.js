/*
 * EVE 辅助工具 —— 技能表自检
 * 运行：node src/core/skill-table.test.js
 *
 * 验证重点：
 *   1. 技能表是唯一来源（skill-map / skills / 前端 三处不再各存一份）
 *   2. 国服中文名与效果描述正确（用户反馈过的四处必须正确）
 *   3. typeID 在国服 ESI 与本地英文表都成立
 *   4. 三个易混淆技能的作用对象不串（科学原理 / 研究概论 / 冶金学）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const SM = require("./skill-map.js");
const K = require("./skills.js");
const { store } = require("../data/store.js");

const ROOT = path.join(__dirname, "..", "..");
const SKILL_FILE = path.join(ROOT, "data", "sde", "skills_zh.json");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

console.log("EVE 辅助工具 · 技能表自检");

/* ---------------- 1. 唯一来源 ---------------- */
section("【技能表是唯一来源】");
{
  const doc = JSON.parse(fs.readFileSync(SKILL_FILE, "utf8"));
  ok(doc.skills && doc.skills.length >= 15, "技能表条目数", doc.skills.length + " 项");

  // skill-map.js 加载自 JSON
  const mapSrc = fs.readFileSync(path.join(__dirname, "skill-map.js"), "utf8");
  ok(mapSrc.includes("skills_zh.json"), "skill-map.js 从 JSON 加载");
  ok(!/nameZh:\s*"/.test(mapSrc), "skill-map.js 不再硬编码中文名");

  // skills.js 也从 skill-map 派生
  const skillsSrc = fs.readFileSync(path.join(__dirname, "skills.js"), "utf8");
  ok(skillsSrc.includes("require(\"./skill-map.js\")"), "skills.js 从 skill-map 派生");
  ok(!/name:\s*"[^"]*学"/.test(skillsSrc), "skills.js 不再硬编码技能名");

  // 前端从接口加载
  const appSrc = fs.readFileSync(path.join(ROOT, "src", "ui", "app.js"), "utf8");
  ok(appSrc.includes("/api/skills"), "前端从 /api/skills 加载");
  ok(!/var SKILL_LIST = \[\s*\{/.test(appSrc), "前端不再硬编码技能列表");

  // 三处内容一致
  const mapNames = SM.SKILL_TABLE.map(s => s.id + ":" + s.nameZh).join("|");
  const skillsNames = K.SKILLS.map(s => s.id + ":" + s.name).join("|");
  ok(mapNames === skillsNames, "skill-map 与 skills 的技能集完全一致");
}

/* ---------------- 2. 国服中文名（用户反馈过的） ---------------- */
section("【国服中文名（2026-11-04 用户反馈修正）】");
{
  const byZh = {};
  SM.SKILL_TABLE.forEach(s => { byZh[s.nameZh] = s; });

  ok(byZh["海关操作专业理论"], "报关代码专家 → 海关操作专业理论");
  ok(byZh["海关操作专业理论"].nameEn === "Customs Code Expertise",
    "海关操作专业理论 的官方英文名是 Customs Code Expertise");
  ok(byZh["海关操作专业理论"].typeId === 33467, "海关操作专业理论 typeID=33467");

  ok(byZh["实验室运作理论"], "实验室操作 → 实验室运作理论");
  ok(byZh["实验室运作理论"].typeId === 3406, "实验室运作理论 typeID=3406");
  ok(byZh["高级实验室运作理论"], "高级实验室技术 → 高级实验室运作理论");
  ok(byZh["高级实验室运作理论"].typeId === 24624, "高级实验室运作理论 typeID=24624");

  ok(!SM.SKILL_TABLE.some(s => s.nameZh === "报关代码专家"), "旧名「报关代码专家」已移除");
  ok(!SM.SKILL_TABLE.some(s => s.nameZh === "实验室操作"), "旧名「实验室操作」已移除");
  ok(!SM.SKILL_TABLE.some(s => s.nameZh === "高级实验室技术"), "旧名「高级实验室技术」已移除");
  ok(!SM.SKILL_TABLE.some(s => s.nameZh === "资源管理"), "旧名「资源管理」已移除（国服未实装）");
}

/* ---------------- 3. typeID 一致性 ---------------- */
section("【typeID 一致性】");
{
  let bad = 0;
  SM.SKILL_TABLE.forEach(s => {
    if (s.typeId == null) return;
    const local = store.englishName(s.typeId);
    if (!local) { bad++; console.log("       ! 本地英文表缺 typeID " + s.typeId + " (" + s.nameEn + ")"); }
    else if (local.toLowerCase() !== s.nameEn.toLowerCase()) {
      bad++;
      console.log("       ! typeID " + s.typeId + " 本地=" + local + " 表=" + s.nameEn);
    }
  });
  ok(bad === 0, "技能 typeID 与本地英文表一致", bad === 0 ? "全部匹配" : bad + " 处不一致");

  // id 唯一
  const ids = SM.SKILL_TABLE.map(s => s.id);
  ok(new Set(ids).size === ids.length, "内部 id 无重复");
  // typeId 唯一
  const tids = SM.SKILL_TABLE.filter(s => s.typeId != null).map(s => s.typeId);
  ok(new Set(tids).size === tids.length, "typeID 无重复");
}

/* ---------------- 4. 易混淆技能的作用对象 ---------------- */
section("【易混淆技能的作用对象】");
{
  const sci = SM.byId("sci");
  const research = SM.byId("research");
  const metal = SM.byId("metal");

  ok(sci && sci.typeId === 3402, "科学原理 = Science(3402)");
  ok(research && research.typeId === 3403, "研究概论 = Research(3403)");
  ok(metal && metal.typeId === 3409, "冶金学 = Metallurgy(3409)");

  // 效果描述必须体现各自的作用对象，不能互相串
  ok(sci.effect.indexOf("拷贝") >= 0, "科学原理 → 蓝图拷贝速度");
  ok(research.effect.indexOf("研究") >= 0, "研究概论 → 蓝图研究");
  ok(metal.effect.indexOf("材料效率") >= 0 || metal.effect.indexOf("ME") >= 0,
    "冶金学 → 材料效率（ME）研究速度");
  ok(sci.effect !== research.effect, "科学原理与研究概论的效果描述不同");
  ok(sci.effect !== metal.effect, "科学原理与冶金学的效果描述不同");

  // ★ 公式必须按作用对象分配（TE 用 research，不是 sci）
  ok(Math.abs(K.researchTimeMult({ research: 5 }, 3) - 0.75) < 1e-9,
    "TE 研究只受「研究概论」影响", K.researchTimeMult({ research: 5 }, 3));
  ok(Math.abs(K.researchTimeMult({ sci: 5 }, 3) - 1) < 1e-9,
    "★「科学原理」不影响 TE 研究（原来误用了 sci）");
  ok(Math.abs(K.researchTimeMult({ sci: 5, metal: 5 }, 4) - 0.75 * 0.75) < 1e-9,
    "ME 研究受「科学原理 + 冶金学」");
  ok(Math.abs(K.researchTimeMult({ sci: 5 }, 5) - 0.75) < 1e-9,
    "拷贝受「科学原理」");
}

/* ---------------- 5. 槽位公式 ---------------- */
section("【槽位公式】");
{
  ok(K.manufacturingSlots({}) === 1, "基础制造槽 1");
  ok(K.manufacturingSlots({ massprod: 5 }) === 6, "批量生产学 5 → 6 槽");
  ok(K.manufacturingSlots({ massprod: 5, advmassprod: 5 }) === 11, "含高级量产技术 → 11 槽");
  ok(K.labSlots({}) === 1, "基础研究槽 1");
  ok(K.labSlots({ lab: 5 }) === 6, "实验室运作理论 5 → 6 槽");
  ok(K.labSlots({ lab: 5, advlab: 5 }) === 11,
    "★ 含高级实验室运作理论 → 11 槽（原来漏算 advlab）");
}

/* ---------------- 6. 效果描述完整性 ---------------- */
section("【效果描述完整性】");
{
  SM.SKILL_TABLE.forEach(s => {
    ok(!!s.effect && s.effect.length > 4, s.nameZh + " 有效果描述", s.effect);
    ok(!!s.effectEn, s.nameZh + " 保留了官方英文描述");
    ok(!!s.group, s.nameZh + " 有分类", s.group);
  });
}

console.log("\n====================================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("====================================================");
process.exit(fail === 0 ? 0 : 1);
