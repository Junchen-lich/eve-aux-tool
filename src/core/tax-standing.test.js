"use strict";

/* ------------------------------------------------------------------ *
 * 税率与声望的回归测试
 *
 * ★ 固化的三个易踩坑：
 *   1. 三服税率不同 —— 欧服 7.5%/3%，国服 8%/2.5%。
 *      用全局单值会让每一服的利润数字都算错。
 *   2. 中介费的官方公式含两项声望修正
 *      （−0.03%×势力声望 −0.02%×军团声望），
 *      此前配置表里配了系数但代码从不读取 → 中介费系统性偏高。
 *   3. 声望与「挂单所在空间站的站主」绑定，
 *      必须先知道站主所属势力才能确定该填哪项声望。
 * ------------------------------------------------------------------ */

const fs = require("fs");
const path = require("path");

const S = require("./skills.js");
const ST = require("./stations.js");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL " + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + "（实际 " + JSON.stringify(a) + "，期望 " + JSON.stringify(b) + "）"); }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= (tol || 1e-9), msg + "（实际 " + a + "，期望 ≈" + b + "）"); }
function section(t) { console.log("\n" + t); }

/* ---------------- 1. 各服税率基准 ---------------- */
section("【各服税率基准】");
{
  ok(S.TAX_BY_SERVER && Object.keys(S.TAX_BY_SERVER).length >= 3, "配置表含三服税率基准");

  const eu = S.taxBaseFor("tranquility");
  const cn = S.taxBaseFor("serenity");
  const sg = S.taxBaseFor("shuguang");

  near(eu.salesTax, 0.075, 1e-9, "欧服销售税基础 7.5%");
  near(eu.brokerFee, 0.03, 1e-9, "欧服中介费基础 3%");
  near(cn.salesTax, 0.08, 1e-9, "国服晨曦销售税基础 8%");
  near(cn.brokerFee, 0.025, 1e-9, "国服晨曦中介费基础 2.5%");
  near(sg.salesTax, 0.08, 1e-9, "国服曙光销售税基础 8%（与晨曦同集群同税率）");
  near(sg.brokerFee, 0.025, 1e-9, "国服曙光中介费基础 2.5%");

  ok(cn.salesTax !== eu.salesTax, "★ 三服税率确实不同（国服 ≠ 欧服）");
  ok(cn.salesTax === sg.salesTax && cn.brokerFee === sg.brokerFee,
    "★ 晨曦与曙光税率一致");

  // 未知服务器回退到全局值
  const un = S.taxBaseFor("no-such-server");
  ok(un && typeof un.salesTax === "number", "未知服务器回退到全局基准值");
}

/* ---------------- 2. 销售税（乘法口径）---------------- */
section("【销售税公式】");
{
  // 欧服：7.5% × (1 − 0.11×5) = 3.375% ✓ 与官方 3.37% 吻合
  near(S.salesTaxRate({ acct: 5 }, "tranquility"), 0.03375, 1e-9,
    "欧服会计学 5 级 → 3.375%（官方 3.37%）");
  // 国服：8% × 0.45 = 3.6% ✓ 与国服 wiki「约 3.6%–8%」吻合
  near(S.salesTaxRate({ acct: 5 }, "serenity"), 0.036, 1e-9,
    "★ 国服会计学 5 级 → 3.6%（与国服 wiki 区间吻合）");
  near(S.salesTaxRate({ acct: 0 }, "serenity"), 0.08, 1e-9, "国服 0 级 → 8%");
  near(S.salesTaxRate({}, "serenity"), 0.08, 1e-9, "★ 无技能数据时按 0 级算（不报错）");
  ok(S.salesTaxRate({ acct: 5 }, "serenity") > S.salesTaxRate({ acct: 5 }, "tranquility"),
    "★ 同技能下国服销售税高于欧服（8% vs 7.5% 基准 → 3.6% vs 3.375%）");
}

/* ---------------- 3. 中介费：技能 + 声望 ---------------- */
section("【中介费公式（含声望修正）】");
{
  // 欧服：3% − 0.3%×5 = 1.5%
  near(S.brokerFeeRate({ broker_rel: 5 }, null, "tranquility"), 0.015, 1e-9,
    "欧服经纪人关系学 5 级 → 1.5%");

  // ★ 声望修正：势力声望 10 点 → −0.3%
  const withFaction = S.brokerFeeRate({ broker_rel: 0 }, { factionStanding: 10 }, "tranquility");
  near(withFaction, 0.03 - 0.003, 1e-9, "★ 势力声望 10 点 → 减 0.3%");
  // 军团声望 10 点 → −0.2%
  const withCorp = S.brokerFeeRate({ broker_rel: 0 }, { corpStanding: 10 }, "tranquility");
  near(withCorp, 0.03 - 0.002, 1e-9, "★ 军团声望 10 点 → 减 0.2%");
  // 两项同时满 → −0.5%
  const both = S.brokerFeeRate({ broker_rel: 0 }, { factionStanding: 10, corpStanding: 10 }, "tranquility");
  near(both, 0.03 - 0.005, 1e-9, "★ 两项声望满值 → 共减 0.5%");

  // 下限 1%
  near(S.brokerFeeRate({ broker_rel: 5 }, { factionStanding: 10, corpStanding: 10 }, "tranquility"),
    0.01, 1e-9, "★ 下限 1% 生效（不会算出负费率）");

  // 负声望会提高费率
  const neg = S.brokerFeeRate({ broker_rel: 0 }, { factionStanding: -10 }, "tranquility");
  near(neg, 0.03 + 0.003, 1e-9, "★ 负声望会提高费率");

  // 声望只取原始值（不做技能加成调整）
  eq(S.standingValue(7.6), 8, "声望取整");
  eq(S.standingValue(-3), -3, "负声望保留");
  eq(S.standingValue(999), 10, "★ 声望上限 10");
  eq(S.standingValue(-999), -10, "★ 声望下限 −10");
  eq(S.standingValue("abc"), 0, "非法输入按 0 处理");
}

/* ---------------- 4. 站主与势力识别 ---------------- */
section("【空间站站主识别】");
{
  // ★ 用户实际给的站：新版新增，ESI 与本地 SDE 表都没收录
  const manual = ST.resolveByName("索巴色基 5 - 星捷运 自由贸易中心");
  eq(manual.corpName, "星捷运", "★ 从站名切出站主「星捷运」");
  ok(manual.known, "★ 站主所属势力已识别");
  eq(manual.factionId, 500003, "★ 星捷运归艾玛帝国（InterBus 由四大帝国合资）");

  // 本地表内的站
  const stations = ST.loadStations();
  ok(stations.length > 1000, "本地空间站表已载入（" + stations.length + " 条）");

  const caldari = ST.resolveStationOwner(
    stations.filter(s => /加达里海军/.test(s.name))[0]);
  eq(caldari.factionId, 500001, "加达里海军的站 → 加达里联邦");
  eq(caldari.factionZh, "加达里联邦", "势力中文名正确");

  // 设施名不能切错（「库房」不该先于「食品包装厂」命中）
  const food = ST.resolveStationOwner(
    stations.filter(s => /加达里后勤部 食品包装厂/.test(s.name))[0]);
  eq(food.corpName, "加达里后勤部", "★ 设施名「食品包装厂」被正确剥离");
  eq(food.factionId, 500001, "加达里后勤部 → 加达里联邦");

  // 未知公司 → 未识别（玩家自建站常见）
  const unknown = ST.resolveByName("某某玩家自建站 工厂");
  ok(!unknown.known, "未收录公司 → 标记为未识别（玩家自建站，业主自设费率）");

  // 覆盖率
  let okN = 0;
  stations.forEach(s => { if (ST.resolveStationOwner(s).factionId) okN++; });
  ok(okN / stations.length > 0.8,
    "★ NPC 空间站势力识别覆盖率 > 80%（实际 " + (okN / stations.length * 100).toFixed(1) + "%）");
}

/* ---------------- 5. 搜索 ---------------- */
section("【空间站搜索】");
{
  const hit = ST.searchStations("索巴色基", 20);
  ok(hit.length > 0, "按星系名搜索有结果（" + hit.length + " 条）");
  ok(hit.every(s => /索巴色基/.test(s.name + s.systemName)), "结果均匹配关键词");

  const byRegion = ST.searchStations("长征", 20);
  ok(byRegion.length > 0, "按区域名搜索有结果（" + byRegion.length + " 条）");

  const none = ST.searchStations("绝对不存在的空间站名XYZ", 20);
  eq(none.length, 0, "无匹配时返回空数组");
}

/* ---------------- 6. 税率配置表结构 ---------------- */
section("【tax_config.json 结构】");
{
  const raw = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "..", "data", "sde", "tax_config.json"), "utf8"));
  ok(raw.servers && Object.keys(raw.servers).length >= 3, "配置表含 servers 段");
  ok(raw.brokerFee && typeof raw.brokerFee.factionStandingPerPoint === "number",
    "★ 配置表含势力声望系数");
  ok(raw.brokerFee && typeof raw.brokerFee.corpStandingPerPoint === "number",
    "★ 配置表含军团声望系数");
  ok(raw._meta && Array.isArray(raw._meta.sources) && raw._meta.sources.length >= 3,
    "配置表标注了出处来源");
  ok(raw._meta && raw._meta.reviewTrigger, "配置表标注了复核触发条件");
}

console.log("\n====================================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("====================================================");
process.exit(fail === 0 ? 0 : 1);
