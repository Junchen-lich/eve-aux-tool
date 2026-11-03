/*
 * EVE 辅助工具 —— 补齐技能类英文名（item_names_en.json）
 *
 * 运行：node scripts/fill_skill_names.js
 *
 * ★ 为什么需要
 *   item_names_en.json 由本地 SDE 的 invTypes.csv 生成，
 *   而本地 SDE 版本较旧 —— 后加入的技能（如 Customs Code Expertise,
 *   typeID 33467）不在其中，导致：
 *     - store.englishName(33467) 返回 null
 *     - 技能表与本地英文表的 typeID 一致性校验失败
 *
 * ★ 数据来源
 *   国服 ESI https://ali-esi.evepc.163.com/latest/universe/types/{type_id}
 *   （公开接口，无需鉴权；type_id 与欧服 SDE 一致，三服通用）
 *
 * ★ 只补技能类
 *   仅处理技能表（data/sde/skills_zh.json）里列出的 typeId，
 *   不动其他物品 —— 避免用 ESI 覆盖本地 SDE 的全部数据。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const EN_FILE = path.join(ROOT, "data", "sde", "item_names_en.json");
const SKILL_FILE = path.join(ROOT, "data", "sde", "skills_zh.json");
const ESI = "https://ali-esi.evepc.163.com/latest/universe/types/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchType(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ESI + id, {
        headers: { "User-Agent": "EVE-AuxTool/0.1", "Accept": "application/json" },
        signal: AbortSignal.timeout(15000)
      });
      if (res.status === 429 || res.status === 420) { await sleep(1500); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      await sleep(1200);
    }
  }
  return null;
}

(async function main() {
  const en = JSON.parse(fs.readFileSync(EN_FILE, "utf8"));
  const skillDoc = JSON.parse(fs.readFileSync(SKILL_FILE, "utf8"));

  const missing = skillDoc.skills
    .map((s) => s.typeId)
    .filter((id) => id != null && !en[String(id)]);

  if (!missing.length) {
    console.log("✓ 技能类英文名齐全，无需补齐");
    return;
  }
  console.log("缺少 " + missing.length + " 个技能英文名，开始从国服 ESI 补齐…");

  let added = 0;
  for (const id of missing) {
    const t = await fetchType(id);
    if (t && t.name) {
      en[String(id)] = t.name;
      added++;
      console.log("  + " + id + "  " + t.name);
    } else {
      console.log("  ! " + id + "  取不到（ESI 无此类型）");
    }
    await sleep(300);
  }

  if (added) {
    fs.writeFileSync(EN_FILE, JSON.stringify(en, null, 0), "utf8");
    console.log("✓ 已补齐 " + added + " 条，写入 " + path.relative(ROOT, EN_FILE));
  }
})();
