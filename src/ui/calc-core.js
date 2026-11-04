/*
 * EVE 辅助工具 —— 浏览器端计算适配层
 * Copyright (C) 2026 Junchen-lich
 *
 * ★ 为什么需要这一层
 *
 *   src/core/skills.js 是计算内核的**唯一真源**，但它依赖 Node 的 fs 读取
 *   tax_config.json，浏览器无法直接加载。
 *   本文件把内核的纯计算部分在浏览器侧重新实现，并从后端拉取税率参数
 *   （/api/config 已返回），保证前后端口径一致。
 *
 * ★ 一致性约束
 *
 *   本文件的公式必须与 src/core/skills.js 严格一致。
 *   改动任一处都必须同步另一处，并运行：
 *     node src/core/skills.test.js        （Node 侧 38 项）
 *     src/ui/calc-core.test.js            （浏览器侧对照测试）
 *
 *   两边的税率参数都来自 data/sde/tax_config.json —— Node 侧读文件，
 *   浏览器侧由 /api/config 下发，不会出现两套基准值。
 */
(function (global) {
  "use strict";

  /* ---------- 税率基准（由后端 /api/config 下发后覆盖）---------- */
  var TAX = {
    salesTax: 0.075,
    brokerFee: 0.03,
    brokerFeePerLevel: 0.003,
    brokerFeeMin: 0.01,
    factionStandingPerPoint: 0.0003,
    corpStandingPerPoint: 0.0002,
    piImportExportBase: 0.10,
    piTaxPerLevel: 0.10
  };

  /* ---------- 各服税率基准（欧服 7.5%/3%，国服 8%/2.5%）---------- */
  /* ★ 内置兜底值：即使 /api/config 尚未返回，也不会用错服的税率。
       后端下发后会被 setTaxConfig 覆盖（以后端为准）。 */
  var TAX_BY_SERVER = {
    tranquility: { salesTax: 0.075, brokerFee: 0.03 },
    serenity: { salesTax: 0.08, brokerFee: 0.025 },
    shuguang: { salesTax: 0.08, brokerFee: 0.025 }
  };

  /* ---------- 技能等级取值 ---------- */
  function lv(skills, id) {
    if (!skills) return 0;
    var v = Number(skills[id]);
    if (!isFinite(v) || v < 0) return 0;
    return Math.min(5, Math.floor(v));
  }

  /** 声望值：取整并限制在 −10 ~ +10（游戏内声望范围），负声望会提高费率 */
  function standingValue(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.max(-10, Math.min(10, Math.round(n)));
  }

  /** 取某服的税率基准 */
  function taxBaseFor(serverKey) {
    var s = TAX_BY_SERVER[serverKey];
    if (!s) return TAX;
    return {
      salesTax: s.salesTax,
      brokerFee: s.brokerFee,
      brokerFeePerLevel: TAX.brokerFeePerLevel,
      brokerFeeMin: TAX.brokerFeeMin,
      factionStandingPerPoint: TAX.factionStandingPerPoint,
      corpStandingPerPoint: TAX.corpStandingPerPoint
    };
  }

  /* ---------- 税率 ---------- */

  /**
   * 有效销售税：基础 × (1 − 0.11 × 会计学等级)
   * 欧服 7.5% × (1 − 0.11×5) = 3.375%（官方 3.37%）
   * 国服 8%   × (1 − 0.11×5) = 3.6%
   */
  function salesTaxRate(skills, serverKey) {
    var base = serverKey ? taxBaseFor(serverKey).salesTax : TAX.salesTax;
    return salesTaxRateWithBase(skills, base);
  }

  /** 同上，但基础值由调用方指定（用于「用户自定义税率」场景） */
  function salesTaxRateWithBase(skills, base) {
    var b = typeof base === "number" ? base : TAX.salesTax;
    return Math.max(0, b * (1 - 0.11 * lv(skills, "acct")));
  }

  /**
   * 有效经纪费（NPC 站）：基础 − 0.3%×等级 − 0.03%×势力声望 − 0.02%×军团声望，下限 1%
   * 声望只取未经技能调整的原始值；负声望会提高费率。
   */
  function brokerFeeRate(skills, standing, serverKey) {
    var t = serverKey ? taxBaseFor(serverKey) : TAX;
    return brokerFeeRateWithBase(skills, standing, t.brokerFee);
  }

  /** 同上，但基础值由调用方指定 */
  function brokerFeeRateWithBase(skills, standing, base) {
    var t = serverKeylessTax(base);
    var r = t.brokerFee - t.brokerFeePerLevel * lv(skills, "broker_rel");
    if (standing) {
      r -= t.factionStandingPerPoint * standingValue(standing.factionStanding);
      r -= t.corpStandingPerPoint * standingValue(standing.corpStanding);
    }
    return Math.max(t.brokerFeeMin, r);
  }

  /** 用给定的基础中介费组装一份临时税率参数 */
  function serverKeylessTax(base) {
    return {
      brokerFee: typeof base === "number" ? base : TAX.brokerFee,
      brokerFeePerLevel: TAX.brokerFeePerLevel,
      brokerFeeMin: TAX.brokerFeeMin,
      factionStandingPerPoint: TAX.factionStandingPerPoint,
      corpStandingPerPoint: TAX.corpStandingPerPoint
    };
  }

  /** 玩家建筑的经纪费由业主设定，技能不影响 */
  function brokerFeeRateStructure(skills, structureRate) {
    if (structureRate == null) return brokerFeeRate(skills);
    return structureRate;
  }

  /* ---------- 生产系数 ---------- */

  /** 制造时间系数：工业理论 −4%/级 × 高级工业理论 −3%/级 */
  function manufacturingTimeMult(skills) {
    var f = (1 - 0.04 * lv(skills, "ind")) * (1 - 0.03 * lv(skills, "advind"));
    return Math.max(0.2, f);
  }

  /** 研发时间系数 */
  function researchTimeMult(skills) {
    var f = (1 - 0.04 * lv(skills, "ind")) * (1 - 0.03 * lv(skills, "advind"));
    return Math.max(0.2, f);
  }

  /** 同时制造槽数 */
  function manufacturingSlots(skills) {
    return 1 + lv(skills, "massprod") + lv(skills, "advmassprod");
  }

  /**
   * 研发/拷贝同时槽数
   * ★「实验室运作理论」+1，「高级实验室运作理论」再 +1（需前者 V 级）
   */
  function labSlots(skills) {
    return 1 + lv(skills, "lab") + lv(skills, "advlab");
  }

  /** 精炼产出加成百分比 */
  function refineYieldBonusPct(skills) {
    return 3 * lv(skills, "refine") + 2 * lv(skills, "refining");
  }

  /** 行星工业 NPC 税 */
  function piTaxRate(skills) {
    return Math.max(0, TAX.piImportExportBase * (1 - TAX.piTaxPerLevel * lv(skills, "pi_customs")));
  }

  /* ---------- ME / TE ---------- */

  /**
   * ME 材料数量：每级 ME 减少 1%（作用在整个 job 上）
   * 官方取整规则：向上取整到下一位有效数字（14.4 → 15）
   */
  function materialQuantity(baseQty, meLevel, runs) {
    var reduction = Math.min(10, Math.max(0, meLevel)) / 100;
    var factor = 1 - reduction;
    var total = baseQty * runs * factor;
    if (total <= 0) return 0;
    return Math.ceil(total);
  }

  /** ME 系数（不含取整） */
  function materialFactor(meLevel) {
    return 1 - Math.min(10, Math.max(0, meLevel)) / 100;
  }

  /** TE 系数：每级 2% */
  function timeFactor(teLevel) {
    return 1 - Math.min(20, Math.max(0, teLevel)) * 0.02;
  }

  /* ---------- 成本与收益 ---------- */

  /** 单件制造成本 */
  function manufacturingCost(p) {
    var perRun = p.materialsCost + p.jobFee;
    var perItem = p.productQty > 0 ? perRun / p.productQty : 0;
    var total = perRun * p.runs;
    return { perRun: perRun, perItem: perItem, total: total };
  }

  /**
   * 挂单收益
   * margin = 利润/成本（投资回报率）；netMargin = 利润/毛收入（毛利率）
   */
  function sellRevenue(p) {
    var gross = p.sellPrice * p.qty;
    var taxAmount = gross * p.salesTax;
    var feeAmount = gross * p.brokerFee;
    var net = gross - taxAmount - feeAmount;
    var cost = p.costPerItem * p.qty;
    var profit = net - cost;
    return {
      gross: gross,
      taxAmount: taxAmount,
      feeAmount: feeAmount,
      net: net,
      cost: cost,
      profit: profit,
      margin: gross > 0 ? (profit / cost) * 100 : 0,
      netMargin: gross > 0 ? (profit / gross) * 100 : 0,
      breakEvenPrice: (p.costPerItem / Math.max(1e-9, (1 - p.salesTax - p.brokerFee)))
    };
  }

  /** 给定目标投资回报率，求最低卖价 */
  function priceForMargin(p) {
    var denom = 1 - p.salesTax - p.brokerFee;
    if (denom <= 0) return 0;
    return (p.costPerItem * (1 + p.targetMargin)) / denom;
  }

  /** 给定目标毛利率，求最低卖价 */
  function priceForNetMargin(p) {
    var denom = 1 - p.salesTax - p.brokerFee - p.targetMargin;
    if (denom <= 0) return 0;
    return p.costPerItem / denom;
  }

  /** 每日产能估算 */
  function dailyOutput(p) {
    var secondsPerRun = p.secondsPerRun;
    var runsPerDay = secondsPerRun > 0 ? (86400 / secondsPerRun) * p.slots : 0;
    return {
      runsPerDay: runsPerDay,
      itemsPerDay: runsPerDay * (p.productQty || 0),
      secondsPerRun: secondsPerRun
    };
  }

  /* ---------- 技能效果摘要 ---------- */

  /**
   * 汇总技能带来的各项系数变化，供界面展示
   */
  function skillEffectSummary(skills) {
    return {
      salesTax: salesTaxRate(skills),
      brokerFee: brokerFeeRate(skills),
      timeMult: manufacturingTimeMult(skills),
      slots: manufacturingSlots(skills),
      labSlots: labSlots(skills),
      refineBonus: refineYieldBonusPct(skills)
    };
  }

  /** 注入税率参数（来自后端 /api/config 或直接读 tax_config.json） */
  function setTaxConfig(cfg) {
    if (!cfg) return;
    if (typeof cfg.salesTax === "number") TAX.salesTax = cfg.salesTax;
    if (typeof cfg.brokerFee === "number") TAX.brokerFee = cfg.brokerFee;
    if (typeof cfg.brokerFeePerLevel === "number") TAX.brokerFeePerLevel = cfg.brokerFeePerLevel;
    if (typeof cfg.brokerFeeMin === "number") TAX.brokerFeeMin = cfg.brokerFeeMin;
    if (typeof cfg.factionStandingPerPoint === "number") {
      TAX.factionStandingPerPoint = Math.abs(cfg.factionStandingPerPoint);
    }
    if (typeof cfg.corpStandingPerPoint === "number") {
      TAX.corpStandingPerPoint = Math.abs(cfg.corpStandingPerPoint);
    }
    if (typeof cfg.piImportExportBase === "number") TAX.piImportExportBase = cfg.piImportExportBase;
    if (typeof cfg.piTaxPerLevel === "number") TAX.piTaxPerLevel = cfg.piTaxPerLevel;
    // ★ 各服基准税率（三服不同）
    if (cfg.servers && typeof cfg.servers === "object") {
      Object.keys(cfg.servers).forEach(function (k) {
        var s = cfg.servers[k] || {};
        if (typeof s.salesTax !== "number" || typeof s.brokerFee !== "number") return;
        TAX_BY_SERVER[k] = { salesTax: s.salesTax, brokerFee: s.brokerFee };
      });
    }
  }

  global.EveCalc = {
    TAX: TAX,
    TAX_BY_SERVER: TAX_BY_SERVER,
    setTaxConfig: setTaxConfig,
    taxBaseFor: taxBaseFor,
    standingValue: standingValue,
    lv: lv,
    salesTaxRate: salesTaxRate,
    salesTaxRateWithBase: salesTaxRateWithBase,
    brokerFeeRate: brokerFeeRate,
    brokerFeeRateWithBase: brokerFeeRateWithBase,
    brokerFeeRateStructure: brokerFeeRateStructure,
    manufacturingTimeMult: manufacturingTimeMult,
    researchTimeMult: researchTimeMult,
    manufacturingSlots: manufacturingSlots,
    labSlots: labSlots,
    refineYieldBonusPct: refineYieldBonusPct,
    piTaxRate: piTaxRate,
    materialQuantity: materialQuantity,
    materialFactor: materialFactor,
    timeFactor: timeFactor,
    manufacturingCost: manufacturingCost,
    sellRevenue: sellRevenue,
    priceForMargin: priceForMargin,
    priceForNetMargin: priceForNetMargin,
    dailyOutput: dailyOutput,
    skillEffectSummary: skillEffectSummary
  };
})(typeof window !== "undefined" ? window : globalThis);
