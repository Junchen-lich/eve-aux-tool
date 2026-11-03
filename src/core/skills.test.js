/*
 * 计算内核自检 —— 用官方权威数值验证公式
 * 运行：node src/core/skills.test.js
 */
"use strict";

const K = require("./skills.js");

let pass = 0, fail = 0;
function eq(actual, expected, label, tol) {
  const ok = tol != null ? Math.abs(actual - expected) <= tol : actual === expected;
  if (ok) { pass++; console.log("  OK   " + label + "  → " + actual); }
  else { fail++; console.log("  FAIL " + label + "  实际=" + actual + "  期望=" + expected); }
}
function section(t) { console.log("\n" + t); }

section("【税率】官方绝对值公式（EVEU《Tax》+ CCP 支持中心）");
eq(K.salesTaxRate({}), 0.075, "销售税 0 级 = 7.5%");
eq(K.salesTaxRate({ acct: 5 }), 0.075 * 0.45, "销售税 5 级 = 3.375%（官方 3.37%）", 1e-12);
eq(K.salesTaxRate({ acct: 3 }), 0.075 * 0.67, "销售税 3 级 = 5.025%", 1e-12);
eq(K.brokerFeeRate({}), 0.03, "经纪费 0 级 = 3.0%");
eq(K.brokerFeeRate({ broker_rel: 5 }), 0.03 - 0.003 * 5, "经纪费 5 级 = 1.5%");
eq(K.brokerFeeRate({ broker_rel: 5 }), 0.015, "经纪费 5 级 = 1.50%");

section("【对照】旧项目算法（1.5% × (1-0.11×等级)）的偏差");
const oldTax = (l) => 0.015 * (1 - 0.11 * l);   // 旧项目：基础值 1.5%（错），系数 0.11（对）
const oldBroker = (l) => 0.015 * (1 - 0.05 * l);
console.log("  等级 | 旧销售税 | 官方销售税 | 偏差倍数 | 旧经纪费 | 官方经纪费");
for (const l of [0, 3, 5]) {
  const nt = K.salesTaxRate({ acct: l }), ot = oldTax(l);
  const nb = K.brokerFeeRate({ broker_rel: l }), ob = oldBroker(l);
  console.log("   " + l + "   |  " + (ot * 100).toFixed(2) + "%  |   " + (nt * 100).toFixed(2) +
    "%   |   " + (ot / nt).toFixed(1) + "x    |  " + (ob * 100).toFixed(2) + "%   |  " + (nb * 100).toFixed(2) + "%");
}
if (oldTax(5) < K.salesTaxRate({ acct: 5 })) pass++; else fail++;
console.log("  → 旧算法在 5 级会计学时低估销售税 " +
  (K.salesTaxRate({ acct: 5 }) / oldTax(5)).toFixed(1) + " 倍（严重）");

section("【制造时间】工业理论 -4%/级，高级工业理论 -3%/级");
eq(K.manufacturingTimeMult({}), 1, "0 级 = 100%");
eq(K.manufacturingTimeMult({ ind: 5 }), 0.8, "工业理论 5 级 = 80%");
eq(K.manufacturingTimeMult({ ind: 5, advind: 5 }), 0.8 * 0.85, "双 5 级 = 68%");
eq(K.manufacturingTimeMult({ ind: 5, advind: 5 }), 0.68, "双 5 级 = 68%");

section("【研究速度】");
eq(K.researchTimeMult({}, 3), 1, "TE 研究 0 级 = 100%");
eq(K.researchTimeMult({ res: 5 }, 3), 0.75, "TE 研究(研究概论5) = 75%");
eq(K.researchTimeMult({ sci: 5, metal: 5 }, 4), 0.75 * 0.75, "ME 研究(科学5+冶金5) = 56.25%");
eq(K.researchTimeMult({ sci: 5 }, 5), 0.75, "拷贝(科学5) = 75%");
eq(K.researchTimeMult({ sci: 5 }, 8), 0.75, "发明(科学5) = 75%");

section("【槽位与提炼】");
eq(K.manufacturingSlots({}), 1, "制造槽 0 级 = 1");
eq(K.manufacturingSlots({ massprod: 5 }), 6, "制造槽(批量生产学5) = 6");
eq(K.manufacturingSlots({ massprod: 5, advmassprod: 4 }), 10, "制造槽(批量5+高级量产4) = 10");
eq(K.labSlots({ lab: 5 }), 6, "实验室槽 5 级 = 6");
eq(K.refineYieldBonusPct({ refine: 5, refining: 5 }), 25, "提炼加成 25%");

section("【ME 取整规则】官方：向上取整到下一位有效数字");
eq(K.materialQuantity(14.4, 0, 10), 144, "无 ME：14.4×10 = 144");
eq(K.materialQuantity(14.4, 5, 10), Math.ceil(14.4 * 10 * 0.95), "ME5：144×0.95 = 137（向上取整）");
eq(K.materialQuantity(100, 10, 1), 90, "ME10：100×0.9 = 90");
eq(K.materialQuantity(1, 10, 10), 9, "ME10 每 run 1 个 × 10 run = 9（官方：整体套用）");
eq(K.materialFactor(0), 1, "ME0 系数 = 1");
eq(K.materialFactor(10), 0.9, "ME10 系数 = 0.9");
eq(K.timeFactor(20), 0.6, "TE20 时间系数 = 0.6");

section("【挂单收益】");
const sk = { acct: 5, broker_rel: 5 };
const tax = K.salesTaxRate(sk), fee = K.brokerFeeRate(sk);
const r = K.sellRevenue({ sellPrice: 100, costPerItem: 50, qty: 10, salesTax: tax, brokerFee: fee });
eq(r.gross, 1000, "毛收入 = 1000");
eq(r.taxAmount, 1000 * tax, "销售税 = " + (1000 * tax).toFixed(2));
eq(r.feeAmount, 1000 * fee, "经纪费 = " + (1000 * fee).toFixed(2));
eq(r.net, 1000 * (1 - tax - fee), "净收入");
eq(r.profit, 1000 * (1 - tax - fee) - 500, "利润");
eq(r.margin, ((1000 * (1 - tax - fee) - 500) / 500) * 100, "投资回报率 %");

section("【反解最低卖价】");
const be = K.priceForMargin({ costPerItem: 50, salesTax: tax, brokerFee: fee, targetMargin: 0.1 });
const chk = K.sellRevenue({ sellPrice: be, costPerItem: 50, qty: 1, salesTax: tax, brokerFee: fee });
eq(Math.abs(chk.margin - 10) < 0.01, true, "反解卖价代入后利润率 ≈ 10%");

section("【制造成本口径】");
const mc = K.manufacturingCost({ materialsCost: 1000, jobFee: 200, productQty: 10, runs: 5 });
eq(mc.perRun, 1200, "单流程 = 材料 + 工业费");
eq(mc.perItem, 120, "单件 = 单流程 ÷ 产出数");
eq(mc.total, 6000, "总成本 = 单流程 × 流程数");

console.log("\n" + "=".repeat(50));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
