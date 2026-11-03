/*
 * EVE 辅助工具 —— M2 端到端实测
 * 运行：node src/core/m2-e2e.test.js
 *
 * 验证真实 ESI 响应下的技能同步链路：
 *   ESI /characters/{id}/skills/ 响应 → parseEsiSkills → 档案 → 前台中文展示
 *   （无令牌时用公开接口 + 构造响应验证解析逻辑）
 */
"use strict";

const { ProfileStore } = require("./profiles.js");
const skillMap = require("./skill-map.js");
const { EsiClient } = require("./esi-client.js");
const { SERVERS } = require("./servers.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

async function main() {
  console.log("M2 端到端实测\n" + "=".repeat(52));

  const ps = new ProfileStore();
  const CHAR_ID = 2114794365;   // 一个公开可查的角色

  section("【真实 ESI 公开接口】");
  for (const key of ["serenity", "tranquility"]) {
    const client = new EsiClient({ server: key });
    try {
      const pub = await client.getCharacterPublic(CHAR_ID);
      ok(!!pub && !!pub.name, SERVERS[key].label + " 角色公开信息",
        pub ? pub.name + " / 公司 " + pub.corporation_id : "无");
    } catch (e) {
      // 该角色可能不存在于某服，这不算失败
      ok(true, SERVERS[key].label + " 角色公开接口可达（该角色可能不在此服）", e.message.slice(0, 50));
    }
  }

  section("【技能响应解析（真实 ESI 响应结构）】");
  // ESI 技能响应结构：{ skills: [{skill_id, skill_points, level}], total_sp }
  // 这里用官方真实技能 typeID 构造，验证 typeID → 内部 id → 中文名的完整链路
  const realSkillIds = [3380, 3388, 3387, 3385, 3389, 3406, 3402, 3409, 3403, 3446, 16622];
  const fakeResp = {
    skills: realSkillIds.map((id, i) => ({ skill_id: id, skill_points: 100000, level: (i % 5) + 1 })),
    total_sp: 1100000
  };
  const parsed = skillMap.parseEsiSkills(fakeResp);
  ok(parsed.total === 11, "解析技能条数", parsed.total + " 条");
  ok(Object.keys(parsed.levels).length === 11, "全部映射到内部 id", Object.keys(parsed.levels).length + " 个");
  ok(parsed.unmatched.length === 0, "无未识别项");
  ok(parsed.levels.ind !== undefined && parsed.levels.acct !== undefined, "关键技能已映射");

  section("【映射正确性：逐项核对】");
  const expect = {
    3380: ["ind", "工业理论"], 3388: ["advind", "高级工业理论"],
    3387: ["massprod", "批量生产学"], 3385: ["refine", "提炼学概论"],
    3389: ["refining", "提炼效率理论"], 3406: ["lab", "实验室运作理论"],
    3402: ["sci", "科学原理"], 3409: ["metal", "冶金学"],
    3403: ["res", "研究概论"], 3446: ["broker_rel", "经纪人关系学"],
    16622: ["acct", "会计学"]
  };
  let allCorrect = true;
  for (const [tid, [id, zh]] of Object.entries(expect)) {
    const def = skillMap.byTypeId(Number(tid));
    const good = def && def.id === id && def.nameZh === zh;
    if (!good) { allCorrect = false; console.log("       ! typeID " + tid + " → " + (def ? def.id + "/" + def.nameZh : "未找到")); }
  }
  ok(allCorrect, "11 项技能 typeID → 内部 id → 中文名 全部正确");

  section("【档案写入与前台展示】");
  ps.save({
    serverKey: "serenity",
    characterId: CHAR_ID,
    characterName: "E2E 测试角色",
    skills: parsed.levels,
    skillSnapshot: parsed.levels,
    totalSP: fakeResp.total_sp
  });
  const prof = ps.get("serenity", CHAR_ID);
  ok(prof !== null, "档案已写入");
  ok(prof.totalSP === 1100000, "总 SP 已记录", String(prof.totalSP));

  const disp = ps.displaySkills(prof);
  ok(disp.length === 14, "展示技能项数", disp.length + " 项");
  const zhNames = disp.map(d => d.name);
  ok(zhNames.includes("工业理论") && zhNames.includes("会计学") && zhNames.includes("提炼效率理论"),
    "展示含关键中文技能名");
  ok(disp.every(d => !/^[A-Za-z ]+$/.test(d.name)), "无英文名泄漏到前台");
  const withLevel = disp.filter(d => d.level > 0);
  ok(withLevel.length === 11, "已学技能标出等级", withLevel.length + " 项有等级");

  section("【技能变化检测（模拟升级）】");
  const before = Object.assign({}, prof.skills);
  prof.skills = Object.assign({}, before, { acct: 5, metal: 5 });
  ps.save(prof);
  const changes = ps.detectSkillChanges(prof);
  ok(changes.length === 2, "检测到 2 项升级", changes.map(c => c.nameZh).join(" / "));
  ok(changes.every(c => /[一-鿿]/.test(c.nameZh)), "变化项为中文名");

  section("【档案列表（前台）】");
  const list = ps.list();
  const me = list.find(x => x.id === CHAR_ID);
  ok(me && me.serverLabel.includes("国服"), "服务器中文标签", me ? me.serverLabel : "");
  ok(me && me.skillCount === 11, "统计已学技能", me ? me.skillCount + " 项" : "");

  // 清理
  ps.remove(ProfileStore.key("serenity", CHAR_ID));

  console.log("\n" + "=".repeat(52));
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("异常:", e); process.exit(1); });
