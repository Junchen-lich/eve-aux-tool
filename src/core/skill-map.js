/*
 * EVE 辅助工具 —— 技能映射表（后台英文名匹配，前台中文显示）
 * Copyright (C) 2026 Junchen-lich
 *
 * ★ 设计原则
 *
 * 后台（数据匹配层）使用**英文名**作为主键，因为：
 *   1. SDE invTypes 的 typeName 恒为英文，是跨服稳定的标识
 *   2. ESI /universe/types/{id} 返回的 name 也是英文（实测国服欧服一致）
 *   3. ESI 技能接口返回的 skill_id 是数字，需要一张「英文名 ↔ typeID ↔ 中文名」的桥接表
 *
 * 前台（展示层）只显示**中文名**，因为用户是国服玩家，中文才是可读信息。
 *
 * ★ 实测结论（2026-11-03）
 *   - 国服 ESI 与欧服 ESI **共用同一套 typeID**：
 *     type 3380 → Industry、3409 → Metallurgy、16622 → Accounting（两端完全一致）
 *   - 因此**无需维护国服专属 typeID 映射表**，本表对三服通用。
 *   - ESI 的 universe/ids **不解析 inventory_types**（只返回角色/公司/联盟等），
 *     故不能靠 ESI 反查 typeID，必须依赖 SDE 英文名表。
 *   - ESI 已将技能 Refining 更名为 **Reprocessing Efficiency**，
 *     SDE 中亦为 Reprocessing Efficiency（旧名 Refining 已不存在于 SDE）。
 */
"use strict";

/**
 * 技能定义表
 * id        内部标识（程序内使用，勿改）
 * nameEn    英文名 —— 后台匹配主键，必须与 SDE invTypes.typeName 完全一致
 * typeId    技能 typeID（= SDE invTypes.typeID）
 * nameZh    中文名 —— 前台显示
 * aliasEn   英文别名（用于兼容历史名与不同命名）
 * effect    效果说明（中文，前台展示）
 * group     分类（中文）
 * esiName   ESI 技能接口使用的 skill_id 对应名称（部分环境仍用旧名）
 */
const SKILL_TABLE = [
  {
    id: "acct", nameEn: "Accounting", typeId: 16622, nameZh: "会计学",
    aliasEn: ["accounting"], esiName: "Accounting",
    effect: "市场销售税每级 -0.55%", group: "贸易"
  },
  {
    id: "broker_rel", nameEn: "Broker Relations", typeId: 3446, nameZh: "经纪人关系学",
    aliasEn: ["broker relations", "broker_rel"], esiName: "Broker Relations",
    effect: "经纪费每级 -0.3%", group: "贸易"
  },
  {
    id: "ind", nameEn: "Industry", typeId: 3380, nameZh: "工业理论",
    aliasEn: ["industry"], esiName: "Industry",
    effect: "制造时间每级 -4%", group: "生产"
  },
  {
    id: "advind", nameEn: "Advanced Industry", typeId: 3388, nameZh: "高级工业理论",
    aliasEn: ["advanced industry"], esiName: "Advanced Industry",
    effect: "所有制造与研究时间每级 -3%", group: "生产"
  },
  {
    id: "massprod", nameEn: "Mass Production", typeId: 3387, nameZh: "批量生产学",
    aliasEn: ["mass production"], esiName: "Mass Production",
    effect: "同时制造槽每级 +1", group: "生产"
  },
  {
    id: "advmassprod", nameEn: "Advanced Mass Production", typeId: null, nameZh: "高级量产技术",
    aliasEn: ["advanced mass production"], esiName: "Advanced Mass Production",
    effect: "同时制造槽每级 +1（需批量生产学 V）", group: "生产"
  },
  {
    id: "supplychain", nameEn: "Supply Chain Management", typeId: null, nameZh: "供给链管理",
    aliasEn: ["supply chain management"], esiName: "Supply Chain Management",
    effect: "远程制造范围每级 +5 跳", group: "生产"
  },
  {
    // ★ 官方英文名是 "Reprocessing"（提炼学概论），不是旧的 "Refining"；
    //   实测 SDE invTypes 与两端 ESI /universe/types/3385 均返回 "Reprocessing"。
    //   "Refining" 作为别名保留，以兼容旧数据与历史称呼。
    id: "refine", nameEn: "Reprocessing", typeId: 3385, nameZh: "提炼学概论",
    aliasEn: ["refining"], esiName: "Reprocessing",
    effect: "精炼产出每级 +3%", group: "提炼"
  },
  {
    id: "refining", nameEn: "Reprocessing Efficiency", typeId: 3389, nameZh: "提炼效率理论",
    aliasEn: ["reprocessing efficiency"], esiName: "Reprocessing Efficiency",
    effect: "精炼产出每级 +2%", group: "提炼"
  },
  {
    id: "lab", nameEn: "Laboratory Operation", typeId: 3406, nameZh: "实验室运作理论",
    aliasEn: ["laboratory operation"], esiName: "Laboratory Operation",
    effect: "研发/拷贝槽每级 +1", group: "科研"
  },
  {
    id: "sci", nameEn: "Science", typeId: 3402, nameZh: "科学原理",
    aliasEn: ["science"], esiName: "Science",
    effect: "材料效率研究/拷贝/发明速度每级 +5%", group: "科研"
  },
  {
    id: "metal", nameEn: "Metallurgy", typeId: 3409, nameZh: "冶金学",
    aliasEn: ["metallurgy"], esiName: "Metallurgy",
    effect: "材料效率研究速度每级 +5%", group: "科研"
  },
  {
    id: "res", nameEn: "Research", typeId: 3403, nameZh: "研究概论",
    aliasEn: ["research"], esiName: "Research",
    effect: "时间效率研究速度每级 +5%", group: "科研"
  },
  {
    id: "pi_customs", nameEn: "Customs Code Expertise", typeId: null, nameZh: "报关代码专家",
    aliasEn: ["customs code expertise"], esiName: "Customs Code Expertise",
    effect: "行星工业 NPC 税每级 -10%", group: "贸易"
  }
];

/* ------------------------------------------------------------------ *
 * 索引构建
 * ------------------------------------------------------------------ */

/** 英文名 → 技能定义（主键匹配） */
const BY_EN_NAME = new Map();
/** typeID → 技能定义 */
const BY_TYPE_ID = new Map();
/** 内部 id → 技能定义 */
const BY_ID = new Map();

for (const s of SKILL_TABLE) {
  BY_ID.set(s.id, s);
  BY_EN_NAME.set(normalizeName(s.nameEn), s);
  for (const a of s.aliasEn || []) BY_EN_NAME.set(normalizeName(a), s);
  if (s.typeId != null) BY_TYPE_ID.set(s.typeId, s);
}

/** 归一化英文名：去空格、转小写、合并多余空白 */
function normalizeName(n) {
  if (n == null) return "";
  return String(n).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 按英文名查找技能
 * @param {string} name 英文名（如 "Industry"）
 * @returns {object|null}
 */
function byEnglishName(name) {
  return BY_EN_NAME.get(normalizeName(name)) || null;
}

/**
 * 按 typeID 查找技能
 */
function byTypeId(typeId) {
  if (typeId == null) return null;
  return BY_TYPE_ID.get(Number(typeId)) || null;
}

/**
 * 按内部 id 查找技能
 */
function byId(id) {
  return BY_ID.get(id) || null;
}

/**
 * 把 ESI 技能响应转换为「内部 id → 等级」的映射
 *
 * ESI `/characters/{id}/skills/` 返回结构：
 *   { "skills": [ { "skill_id": 3380, "skill_points": 160000, "level": 5, ... } ] }
 * 其中 skill_id 即技能 typeID。
 *
 * @param {object} esiResponse ESI 技能响应
 * @returns {{ levels: object, unmatched: array, total: number }}
 *   levels    { 内部id: 等级 }
 *   unmatched 未能识别的 skill_id 列表（用于诊断）
 */
function parseEsiSkills(esiResponse) {
  const out = { levels: {}, unmatched: [], total: 0 };
  const list = (esiResponse && esiResponse.skills) || [];
  out.total = list.length;
  for (const entry of list) {
    const sk = byTypeId(entry.skill_id);
    const lv = Number(entry.level) || 0;
    if (sk) {
      out.levels[sk.id] = lv;
    } else {
      // 兜底：尝试按 ESI 返回的 name 匹配
      const byName = byEnglishName(entry.skill_name);
      if (byName) {
        out.levels[byName.id] = lv;
      } else {
        out.unmatched.push({ skill_id: entry.skill_id, name: entry.skill_name || null, level: lv });
      }
    }
  }
  return out;
}

/**
 * 生成「英文名 → 中文名」显示映射，供前台使用
 */
function displayMap() {
  const m = {};
  for (const s of SKILL_TABLE) m[s.nameEn] = s.nameZh;
  return m;
}

/**
 * 前台展示：把内部 id 技能表转成带中文名的列表
 */
function displayList() {
  return SKILL_TABLE.map(s => ({
    id: s.id,
    name: s.nameZh,        // ← 前台只显示中文
    nameEn: s.nameEn,      // ← 保留英文供调试与导出
    effect: s.effect,
    group: s.group,
    typeId: s.typeId
  }));
}

/** 技能分组（中文分组名 → 技能列表） */
function displayGroups() {
  const groups = new Map();
  for (const s of SKILL_TABLE) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push({ id: s.id, name: s.nameZh, effect: s.effect, typeId: s.typeId });
  }
  return Object.fromEntries(groups);
}

module.exports = {
  SKILL_TABLE,
  normalizeName,
  byEnglishName,
  byTypeId,
  byId,
  parseEsiSkills,
  displayMap,
  displayList,
  displayGroups,
  BY_EN_NAME,
  BY_TYPE_ID,
  BY_ID
};
