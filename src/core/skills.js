/*
 * EVE 辅助工具 —— 技能效果与计算内核
 * Copyright (C) 2026 Junchen-lich
 *
 * ⚠️ 技能效果数值来源与权威性说明
 *
 * 技能效果（每级减多少）属于**游戏机制常量，不在 SDE 静态数据中**，
 * 必须人工维护并随游戏版本核对。数值依据：
 *   - CCP 官方 DevBlog《EVE Industry - All you want to know》（工业理论/高级工业理论/ME/TE）
 *   - CCP 官方支持中心《Broker Fee and Sales Tax》《Material Efficiency Research》
 *   - EVE University Wiki《Tax》（税率权威公式）
 *
 * 与「市场动态与制造核算台」的关键差异（该项目的税率算法有误，见下）：
 *   官方税率口径为**乘法**，基础值固定，技能做相对折减：
 *     销售税 = 7.5% × (1 − 0.11 × 会计学等级)   （5 级 → 3.375%，官方 3.37%）
 *     经纪费 = 3%   − 0.3%  × 经纪人关系学等级   （5 级 → 1.50%，下限 1%）
 *   销售税基础值自版本 22.02（2025-03-12）起由 4% 上调至 7.5%。
 *   旧项目用的是「1.5% × (1 − 0.11×等级)」→ 5 级得 0.67%，低估约 5 倍。
 *   已于 2026-11-03 修正（提交 cc9c435）。
 *
 * ★ 浏览器可用性
 *   本文件仅在 Node 侧读一次 tax_config.json（见 loadTaxConfig）。
 *   浏览器端由 ui/calc-core.js 以同一份税率参数注入，不依赖文件系统。
 *   两端公式必须保持一致 —— 改动此处须同步 ui/calc-core.js 并跑
 *   src/core/skills.test.js（38 项）与 src/data/store.test.js。
 */
"use strict";

/* ------------------------------------------------------------------ *
 * 技能定义
 * typeID 为欧服 ESI 技能 ID；国服 typeID 体系不同，需另建映射表
 * ------------------------------------------------------------------ */
const SKILLS = [
  { id: "acct",       typeId: 16622, name: "会计学",        nameEn: "Accounting",
    effect: "市场销售税每级 -0.55%", group: "贸易" },
  { id: "broker_rel", typeId: 3446,  name: "经纪人关系学",  nameEn: "Broker Relations",
    effect: "经纪费每级 -0.3%", group: "贸易" },

  { id: "ind",        typeId: 3380,  name: "工业理论",      nameEn: "Industry",
    effect: "制造时间每级 -4%", group: "生产" },
  { id: "advind",     typeId: 3388,  name: "高级工业理论",  nameEn: "Advanced Industry",
    effect: "所有制造与研究时间每级 -3%", group: "生产" },
  { id: "massprod",   typeId: 3387,  name: "批量生产学",    nameEn: "Mass Production",
    effect: "同时制造槽每级 +1", group: "生产" },
  { id: "advmassprod", typeId: null, name: "高级量产技术",  nameEn: "Advanced Mass Production",
    effect: "同时制造槽每级 +1（需批量生产学 V）", group: "生产" },
  { id: "supplychain", typeId: null, name: "供给链管理",    nameEn: "Supply Chain Management",
    effect: "远程制造范围每级 +5 跳", group: "生产" },

  { id: "refine",     typeId: 3385,  name: "提炼学概论",    nameEn: "Refining",
    effect: "精炼产出每级 +3%", group: "提炼" },
  { id: "refining",   typeId: 3389,  name: "提炼效率理论",  nameEn: "Reprocessing Efficiency",
    effect: "精炼产出每级 +2%", group: "提炼" },

  { id: "lab",        typeId: 3406,  name: "实验室运作理论", nameEn: "Laboratory Operation",
    effect: "研发/拷贝槽每级 +1", group: "科研" },
  { id: "sci",        typeId: 3402,  name: "科学原理",      nameEn: "Science",
    effect: "材料效率研究/拷贝/发明速度每级 +5%", group: "科研" },
  { id: "metal",      typeId: 3409,  name: "冶金学",        nameEn: "Metallurgy",
    effect: "材料效率研究速度每级 +5%", group: "科研" },
  { id: "res",        typeId: 3403,  name: "研究概论",      nameEn: "Research",
    effect: "时间效率研究速度每级 +5%", group: "科研" }
];

/* ------------------------------------------------------------------ *
 * 工业活动 ID（SDE industryActivity 与 ESI 的语义）
 * 注意：反应是 11，不是 9
 * ------------------------------------------------------------------ */
const ACTIVITY = {
  MANUFACTURING: 1,
  COPYING: 5,
  RESEARCH_TIME: 3,
  RESEARCH_MATERIAL: 4,
  INVENTION: 8,
  REACTION: 11
};

/* ------------------------------------------------------------------ *
 * 官方税率基准
 *
 * 默认值取自 data/sde/tax_config.json（人工维护表，含出处与核对日期）。
 * 若该表存在则以其为准，便于随游戏版本更新而无需改代码。
 * ------------------------------------------------------------------ */
const DEFAULT_TAX = {
  salesTax: 0.075,   // 销售税（交易税）基础 7.5%
  brokerFee: 0.03,   // 经纪费基础 3%（NPC 站）
  brokerFeePerLevel: 0.003,
  // 销售税用乘法：税率 = 基础 × (1 − 0.11×会计学等级)
  salesTaxPerLevel: 0.11,
  brokerFeeMin: 0.01,
  // 行星工业 NPC 进口/出口税基础 10%（安都 10%，需 POCO）
  piImportExportBase: 0.10,
  piTaxPerLevel: 0.10   // 报关代码专家每级 -10%
};

const TAX_BASE = loadTaxConfig();

/** 从内置税率配置表读取基准值；缺省时回退到内置常量 */
function loadTaxConfig() {
  const cfg = Object.assign({}, DEFAULT_TAX);
  try {
    const fs = require("fs");
    const path = require("path");
    const file = path.join(__dirname, "..", "..", "data", "sde", "tax_config.json");
    if (!fs.existsSync(file)) return cfg;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw.salesTax) {
      if (typeof raw.salesTax.base === "number") cfg.salesTax = raw.salesTax.base;
      if (typeof raw.salesTax.perLevel === "number") cfg.salesTaxPerLevel = raw.salesTax.perLevel;
    }
    if (raw.brokerFee) {
      if (typeof raw.brokerFee.base === "number") cfg.brokerFee = raw.brokerFee.base;
      if (typeof raw.brokerFee.perLevel === "number") cfg.brokerFeePerLevel = Math.abs(raw.brokerFee.perLevel);
      if (typeof raw.brokerFee.floor === "number") cfg.brokerFeeMin = raw.brokerFee.floor;
    }
    if (raw.planetaryTax) {
      if (typeof raw.planetaryTax.base === "number") cfg.piImportExportBase = raw.planetaryTax.base;
      if (typeof raw.planetaryTax.perLevel === "number") cfg.piTaxPerLevel = Math.abs(raw.planetaryTax.perLevel);
    }
  } catch (e) {
    // 配置表损坏时用默认值，保证计算不中断
  }
  return cfg;
}

/* ------------------------------------------------------------------ *
 * 技能系数计算
 * 所有函数接受「技能等级对象」，返回 0..1 或具体数值
 * ------------------------------------------------------------------ */

function lv(skills, id) {
  if (!skills) return 0;
  const v = Number(skills[id]);
  if (!isFinite(v)) return 0;
  return Math.max(0, Math.min(5, Math.floor(v)));
}

/** 有效销售税（交易税）：乘法口径
 *  官方：7.5% 基础，"can be reduced down to 3.37% through the Accounting skill"
 *  验算：7.5 × (1 − 0.11×5) = 3.375% ✓ 与官方 3.37% 吻合
 *  旧基础值时代：5 × (1 − 0.11×5) = 2.25% ✓ 与当年官方值吻合
 *  → 系数 0.11 本身正确，旧项目的错误只在于基础值用了 1.5%
 */
function salesTaxRate(skills) {
  return Math.max(0, TAX_BASE.salesTax * (1 - 0.11 * lv(skills, "acct")));
}

/** 有效经纪费（NPC 站）：减法口径
 *  官方公式：3% − 0.3%×BrokerRelationsLevel − 0.03%×FactionStanding − 0.02%×CorpStanding
 *  5 级 → 1.5%，下限 1%
 */
function brokerFeeRate(skills) {
  const r = TAX_BASE.brokerFee - TAX_BASE.brokerFeePerLevel * lv(skills, "broker_rel");
  return Math.max(TAX_BASE.brokerFeeMin, r);
}

/**
 * 有效经纪费（玩家建筑）：由建筑所有者设定，技能不影响
 * 因此玩家建筑的挂单收益核算不应套用技能修正
 */
function brokerFeeRateStructure(skills, structureRate) {
  if (structureRate == null) return brokerFeeRate(skills);
  return structureRate;
}

/** 制造时间系数：工业理论 -4%/级 × 高级工业理论 -3%/级 */
function manufacturingTimeMult(skills) {
  const f = (1 - 0.04 * lv(skills, "ind")) * (1 - 0.03 * lv(skills, "advind"));
  return Math.max(0.2, f);
}

/**
 * 研究时间系数
 * act: 3=时间效率研究(TE) 4=材料效率研究(ME) 5=拷贝 8=发明
 * 官方：ME 研究受「科学原理 + 冶金学」，TE 研究受「研究概论」，
 *       拷贝与发明受「科学原理」
 */
function researchTimeMult(skills, act) {
  let f = 1;
  if (act === ACTIVITY.RESEARCH_MATERIAL) {
    f = (1 - 0.05 * lv(skills, "sci")) * (1 - 0.05 * lv(skills, "metal"));
  } else if (act === ACTIVITY.RESEARCH_TIME) {
    f = (1 - 0.05 * lv(skills, "res"));
  } else if (act === ACTIVITY.COPYING || act === ACTIVITY.INVENTION) {
    f = (1 - 0.05 * lv(skills, "sci"));
  }
  return Math.max(0.2, f);
}

/** 同时制造槽数 */
function manufacturingSlots(skills) {
  return 1 + lv(skills, "massprod") + lv(skills, "advmassprod");
}

/** 研发/拷贝同时槽数 */
function labSlots(skills) {
  return 1 + lv(skills, "lab");
}

/** 精炼产出加成百分比 */
function refineYieldBonusPct(skills) {
  return 3 * lv(skills, "refine") + 2 * lv(skills, "refining");
}

/** 行星工业 NPC 税（报关代码专家每级 -10%） */
function piTaxRate(skills) {
  return Math.max(0, TAX_BASE.piImportExportBase * (1 - TAX_BASE.piTaxPerLevel * lv(skills, "pi_customs")));
}

/* ------------------------------------------------------------------ *
 * 材料效率（ME）与时间效率（TE）
 * ------------------------------------------------------------------ */

/**
 * ME 材料减少系数
 * 官方：每级 ME 减少 1% 材料需求（作用在整个 job 上，不是每 run）
 * 限制：结果向上取整到「下一位有效数字」；
 *       「每 run 需要 1 个单位」的材料不受此计算影响（如 T2 造 T1 材料）
 * @param {number} baseQty 蓝图基础数量
 * @param {number} meLevel  蓝图 ME 等级 0-10
 * @param {number} runs     流程数
 */
function materialQuantity(baseQty, meLevel, runs) {
  const reduction = Math.min(10, Math.max(0, meLevel)) / 100;
  const factor = 1 - reduction;
  const total = baseQty * runs * factor;
  if (total <= 0) return 0;
  // 向上取整到下一位有效数字（官方规则：14.4 → 15）
  return Math.ceil(total);
}

/** 材料减少系数（仅系数，不含取整） */
function materialFactor(meLevel) {
  return 1 - Math.min(10, Math.max(0, meLevel)) / 100;
}

/** TE 时间减少系数：每级 2% */
function timeFactor(teLevel) {
  return 1 - Math.min(20, Math.max(0, teLevel)) * 0.02;
}

/* ------------------------------------------------------------------ *
 * 成本与收益核算
 * ------------------------------------------------------------------ */

/**
 * 单件制造成本
 * @param {object} p
 *  materialsCost  材料总成本（ISK）
 *  jobFee         工业费（安装费 + 设施税 + 系统成本指数部分）
 *  productQty     单流程产出数量
 *  runs           流程数
 */
function manufacturingCost(p) {
  const perRun = p.materialsCost + p.jobFee;
  const perItem = p.productQty > 0 ? perRun / p.productQty : 0;
  const total = perRun * p.runs;
  return { perRun, perItem, total };
}

/**
 * 挂单收益
 * @param {object} p
 *  sellPrice     卖价（单价）
 *  costPerItem   单件成本
 *  qty           数量
 *  salesTax      有效销售税率
 *  brokerFee     有效经纪费率
 */
function sellRevenue(p) {
  const gross = p.sellPrice * p.qty;
  const taxAmount = gross * p.salesTax;
  const feeAmount = gross * p.brokerFee;
  const net = gross - taxAmount - feeAmount;
  const cost = p.costPerItem * p.qty;
  const profit = net - cost;
  return {
    gross,
    taxAmount,
    feeAmount,
    net,
    cost,
    profit,
    margin: gross > 0 ? (profit / cost) * 100 : 0,   // 投资回报率
    netMargin: gross > 0 ? (profit / gross) * 100 : 0, // 毛利率
    breakEvenPrice: (p.costPerItem / Math.max(1e-9, (1 - p.salesTax - p.brokerFee)))
  };
}

/**
 * 反向求解：给定目标投资回报率，求最低卖价
 * 口径与 sellRevenue().margin 一致：margin = 利润 / 成本
 * 令 (P×(1-t-f) - C) / C = m  →  P = C×(1+m) / (1-t-f)
 * @param {object} p  costPerItem / salesTax / brokerFee / targetMargin(小数，如 0.1 = 10%)
 */
function priceForMargin(p) {
  const denom = 1 - p.salesTax - p.brokerFee;
  if (denom <= 0) return 0;
  return (p.costPerItem * (1 + p.targetMargin)) / denom;
}

/**
 * 反向求解：给定目标毛利率，求最低卖价
 * 口径：netMargin = 利润 / 毛收入
 * 令 (P×(1-t-f) - C) / P = m  →  P = C / (1-t-f-m)
 */
function priceForNetMargin(p) {
  const denom = 1 - p.salesTax - p.brokerFee - p.targetMargin;
  if (denom <= 0) return 0;
  return p.costPerItem / denom;
}

/**
 * 每日产能估算
 */
function dailyOutput(p) {
  const secondsPerRun = p.secondsPerRun;
  const runsPerDay = secondsPerRun > 0 ? (86400 / secondsPerRun) * p.slots : 0;
  return {
    runsPerDay,
    itemsPerDay: runsPerDay * p.productQty,
    profitPerDay: runsPerDay * p.profitPerRun
  };
}

/* ------------------------------------------------------------------ *
 * 技能效果总览（用于 UI 展示）
 * ------------------------------------------------------------------ */
function skillEffectSummary(skills) {
  return {
    salesTax: salesTaxRate(skills),
    brokerFee: brokerFeeRate(skills),
    timeMult: manufacturingTimeMult(skills),
    meResearchMult: researchTimeMult(skills, ACTIVITY.RESEARCH_MATERIAL),
    teResearchMult: researchTimeMult(skills, ACTIVITY.RESEARCH_TIME),
    copyMult: researchTimeMult(skills, ACTIVITY.COPYING),
    inventionMult: researchTimeMult(skills, ACTIVITY.INVENTION),
    massSlots: manufacturingSlots(skills),
    labSlots: labSlots(skills),
    refineBonus: refineYieldBonusPct(skills)
  };
}

/* ------------------------------------------------------------------ *
 * ESI 技能 typeID ↔ 内部 id 映射
 * 注意：仅欧服 typeID 已核实；国服 typeID 体系不同，需另行建立
 * ------------------------------------------------------------------ */
const EU_SKILL_TYPEID_MAP = {};
for (const s of SKILLS) {
  if (s.typeId) EU_SKILL_TYPEID_MAP[s.typeId] = s.id;
}

module.exports = {
  SKILLS,
  ACTIVITY,
  TAX_BASE,
  lv,
  salesTaxRate,
  brokerFeeRate,
  brokerFeeRateStructure,
  manufacturingTimeMult,
  researchTimeMult,
  manufacturingSlots,
  labSlots,
  refineYieldBonusPct,
  piTaxRate,
  materialQuantity,
  materialFactor,
  timeFactor,
  manufacturingCost,
  sellRevenue,
  priceForMargin,
  priceForNetMargin,
  dailyOutput,
  skillEffectSummary,
  EU_SKILL_TYPEID_MAP
};
