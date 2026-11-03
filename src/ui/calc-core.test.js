/*
 * 浏览器端计算层 与 Node 端内核的 一致性对照测试
 *
 * 用法：node src/ui/calc-core.test.js
 *
 * 做法：加载 src/ui/calc-core.js（浏览器版）与 src/core/skills.js（Node 版），
 * 对同一组输入逐项比对输出。任何一项不一致即失败。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n【" + t + "】"); }

/* ---------- 加载浏览器版 ---------- */
const ROOT = path.join(__dirname, "..", "..");
const browserSrc = fs.readFileSync(path.join(__dirname, "calc-core.js"), "utf8");
const browserSandbox = { console: console };
vm.createContext(browserSandbox);
vm.runInContext(browserSrc, browserSandbox);
const B = browserSandbox.EveCalc;

/* ---------- 加载 Node 版 ---------- */
const N = require(path.join(ROOT, "src", "core", "skills.js"));

if (!B) {
  console.error("浏览器端未导出 EveCalc");
  process.exit(1);
}

/* ---------- 税率参数一致性 ---------- */
section("【税率参数来源一致】");
{
  const tax = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "sde", "tax_config.json"), "utf8"));
  B.setTaxConfig({
    salesTax: tax.salesTax.base,
    brokerFee: tax.brokerFee.base,
    brokerFeePerLevel: Math.abs(tax.brokerFee.perLevel),
    brokerFeeMin: tax.brokerFee.floor,
    piImportExportBase: tax.planetaryTax.base,
    piTaxPerLevel: Math.abs(tax.planetaryTax.perLevel)
  });
  ok(B.TAX.salesTax === N.TAX_BASE.salesTax, "销售税基础值一致", B.TAX.salesTax);
  ok(B.TAX.brokerFee === N.TAX_BASE.brokerFee, "经纪费基础值一致", B.TAX.brokerFee);
  ok(B.TAX.brokerFeeMin === N.TAX_BASE.brokerFeeMin, "经纪费下限一致", B.TAX.brokerFeeMin);
}

/* ---------- 税率函数逐级比对 ---------- */
section("【税率函数逐级比对】");
{
  for (let l = 0; l <= 5; l++) {
    const sk = { acct: l, broker_rel: l };
    ok(Math.abs(B.salesTaxRate(sk) - N.salesTaxRate(sk)) < 1e-12,
      "销售税 Lv" + l + " 一致",
      B.salesTaxRate(sk).toFixed(6) + " vs " + N.salesTaxRate(sk).toFixed(6));
    ok(Math.abs(B.brokerFeeRate(sk) - N.brokerFeeRate(sk)) < 1e-12,
      "经纪费 Lv" + l + " 一致",
      B.brokerFeeRate(sk).toFixed(6) + " vs " + N.brokerFeeRate(sk).toFixed(6));
  }
  // 官方锚点
  ok(Math.abs(B.salesTaxRate({ acct: 5 }) - 0.03375) < 1e-9,
    "★ 官方锚点：5 级会计学 ≈ 3.37%", (B.salesTaxRate({ acct: 5 }) * 100).toFixed(3) + "%");
  ok(Math.abs(B.brokerFeeRate({ broker_rel: 5 }) - 0.015) < 1e-12,
    "★ 官方锚点：5 级经纪关系 ≈ 1.50%", (B.brokerFeeRate({ broker_rel: 5 }) * 100).toFixed(2) + "%");
  ok(Math.abs(B.brokerFeeRate({ broker_rel: 5, acct: 5 }) - 0.015) < 1e-12,
    "★ 销售税与经纪费互不影响");
}

/* ---------- 生产系数 ---------- */
section("【生产系数比对】");
{
  const cases = [
    { ind: 5, advind: 5 }, { ind: 3, advind: 0 }, { ind: 0, advind: 0 },
    { massprod: 5 }, { lab: 5 }, { refine: 5, refining: 5 }
  ];
  for (const sk of cases) {
    const key = Object.keys(sk).join("+");
    ok(Math.abs(B.manufacturingTimeMult(sk) - N.manufacturingTimeMult(sk)) < 1e-12,
      "制造时间系数 " + key, B.manufacturingTimeMult(sk).toFixed(6));
    ok(B.manufacturingSlots(sk) === N.manufacturingSlots(sk),
      "制造槽数 " + key, B.manufacturingSlots(sk));
    ok(B.labSlots(sk) === N.labSlots(sk), "实验室槽数 " + key, B.labSlots(sk));
    ok(B.refineYieldBonusPct(sk) === N.refineYieldBonusPct(sk),
      "精炼加成 " + key, B.refineYieldBonusPct(sk) + "%");
  }
}

/* ---------- ME / TE ---------- */
section("【ME / TE 取整比对】");
{
  const cases = [
    [86, 0, 1], [86, 5, 1], [86, 10, 1], [1000, 3, 4],
    [1, 10, 1], [14.4, 0, 1], [213, 7, 3]
  ];
  for (const [qty, me, runs] of cases) {
    const a = B.materialQuantity(qty, me, runs);
    const b = N.materialQuantity(qty, me, runs);
    ok(a === b, "材料数量 " + qty + "×" + runs + " ME" + me,
      a + " vs " + b);
  }
  for (let te = 0; te <= 20; te += 5) {
    ok(Math.abs(B.timeFactor(te) - N.timeFactor(te)) < 1e-12, "TE 系数 " + te);
  }
}

/* ---------- 成本与收益 ---------- */
section("【成本与收益比对】");
{
  const p = {
    materialsCost: 120000,
    jobFee: 5000,
    productQty: 10,
    runs: 3
  };
  const a = B.manufacturingCost(p), b = N.manufacturingCost(p);
  ok(a.perRun === b.perRun, "单流程成本一致", a.perRun);
  ok(a.perItem === b.perItem, "单件成本一致", a.perItem.toFixed(2));
  ok(a.total === b.total, "总成本一致", a.total);

  const s = {
    sellPrice: 20000, costPerItem: 15000, qty: 100,
    salesTax: 0.03375, brokerFee: 0.015
  };
  const ra = B.sellRevenue(s), rb = N.sellRevenue(s);
  ok(ra.gross === rb.gross, "毛收入一致", ra.gross);
  ok(ra.taxAmount === rb.taxAmount, "销售税一致", ra.taxAmount.toFixed(2));
  ok(ra.feeAmount === rb.feeAmount, "经纪费一致", ra.feeAmount.toFixed(2));
  ok(ra.profit === rb.profit, "利润一致", ra.profit.toFixed(2));
  ok(Math.abs(ra.margin - rb.margin) < 1e-9, "投资回报率一致", ra.margin.toFixed(4) + "%");
  ok(Math.abs(ra.netMargin - rb.netMargin) < 1e-9, "毛利率一致", ra.netMargin.toFixed(4) + "%");
  ok(Math.abs(ra.breakEvenPrice - rb.breakEvenPrice) < 1e-9,
    "保本价一致", ra.breakEvenPrice.toFixed(4));

  // 反解
  const pm = { costPerItem: 15000, salesTax: 0.03375, brokerFee: 0.015, targetMargin: 0.15 };
  ok(Math.abs(B.priceForMargin(pm) - N.priceForMargin(pm)) < 1e-9,
    "目标回报率反解卖价一致", B.priceForMargin(pm).toFixed(2));
  const pnm = { costPerItem: 15000, salesTax: 0.03375, brokerFee: 0.015, targetMargin: 0.1 };
  ok(Math.abs(B.priceForNetMargin(pnm) - N.priceForNetMargin(pnm)) < 1e-9,
    "目标毛利率反解卖价一致", B.priceForNetMargin(pnm).toFixed(2));
}

/* ---------- 百分比 ↔ 小数 单位陷阱 ---------- */
section("【百分比单位口径（界面易错点）】");
{
  // 界面输入框填「15」表示 15%，公式需要小数 0.15
  const cost = 10000, tax = 0.075, fee = 0.03;
  const denom = 1 - tax - fee;

  const wrong = B.priceForMargin({ costPerItem: cost, salesTax: tax, brokerFee: fee, targetMargin: 15 });
  const right = B.priceForMargin({ costPerItem: cost, salesTax: tax, brokerFee: fee, targetMargin: 0.15 });

  // 反解出的价格，代入回报率公式应恰好等于目标
  const roI = ((right * denom - cost) / cost) * 100;
  ok(Math.abs(roI - 15) < 1e-9, "传 0.15 时反解价格的实际回报率 = 15%", roI.toFixed(6) + "%");
  const roW = ((wrong * denom - cost) / cost) * 100;
  ok(Math.abs(roW - 15) > 1, "传 15 时会放大 100 倍（这就是界面曾出现的 Bug）", roW.toFixed(4) + "%");

  // 保本价（目标 0）
  const be = B.priceForMargin({ costPerItem: cost, salesTax: tax, brokerFee: fee, targetMargin: 0 });
  ok(Math.abs(be - cost / denom) < 1e-9, "目标 0% 时等于保本价", be.toFixed(2));
}

/* ---------- 日产能 ---------- */
section("【日产能比对】");
{
  const p = { secondsPerRun: 600, slots: 2, productQty: 10 };
  const a = B.dailyOutput(p), b = N.dailyOutput(p);
  ok(Math.abs(a.runsPerDay - b.runsPerDay) < 1e-9, "每日流程数一致", a.runsPerDay.toFixed(2));
  ok(Math.abs(a.itemsPerDay - b.itemsPerDay) < 1e-9, "每日产出件数一致", a.itemsPerDay.toFixed(2));
}

/* ---------- 玩家建筑 ---------- */
section("【玩家建筑经纪费比对】");
{
  const sk = { broker_rel: 5 };
  ok(B.brokerFeeRateStructure(sk, 0.05) === N.brokerFeeRateStructure(sk, 0.05),
    "玩家建筑费率由业主设定（技能不生效）", "5%");
  ok(Math.abs(B.brokerFeeRateStructure(sk, null) - N.brokerFeeRateStructure(sk, null)) < 1e-12,
    "未设定时回退 NPC 站口径");
}

console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
