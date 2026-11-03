/*
 * EVE 辅助工具 —— 数据获取模块实测
 * 运行：node src/data/fetcher.test.js
 */
"use strict";

const F = require("./fetcher.js");
const { EsiClient } = require("../core/esi-client.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}

async function main() {
  console.log("EVE 辅助工具 · 数据获取实测\n" + "=".repeat(56));

  // 错误额度监控
  let limitInfo = null;
  const client = new EsiClient({
    server: "serenity",
    onLimit: (remain, reset) => { limitInfo = { remain, reset }; }
  });

  console.log("\n【工业设施费率】");
  const rates = await F.fetchFacilityRates(client);
  ok(Array.isArray(rates) && rates.length > 0, "设施费率聚合", rates.length + " 种 typeID");
  if (rates.length) {
    const s = rates[0];
    ok(s.typeId != null && s.facilities.length > 0, "单条结构",
      "typeId=" + s.typeId + " 设施数=" + s.facilities.length);
  }

  console.log("\n【星系工业成本指数】");
  const idx = await F.fetchCostIndex(client);
  ok(Array.isArray(idx) && idx.length > 5000, "成本指数", idx.length + " 个星系");
  if (idx.length) {
    const s = idx[0];
    ok(s.systemId != null && s.indices, "单条结构",
      "systemId=" + s.systemId + " 活动数=" + Object.keys(s.indices).length);
    ok(s.indices.manufacturing != null, "含制造活动成本指数",
      "manufacturing=" + s.indices.manufacturing);
  }
  const ci = F.costIndexFor(idx[0].systemId, "manufacturing");
  ok(typeof ci === "number", "按星系+活动查询成本指数", ci);

  console.log("\n【EIV 调整后价格】");
  const eiv = await F.fetchEiv(client);
  ok(Object.keys(eiv).length > 10000, "EIV 条目", Object.keys(eiv).length + " 条");
  ok(eiv["34"] && eiv["34"].adjusted > 0, "typeID 34 的调整价",
    eiv["34"] ? "adjusted=" + eiv["34"].adjusted.toFixed(2) : "无");
  ok(F.eivPrice("serenity", 34) > 0, "eivPrice 查询", F.eivPrice("serenity", 34).toFixed(2));

  console.log("\n【错误额度监控】");
  ok(limitInfo !== null, "收到错误额度回调",
    limitInfo ? "remain=" + limitInfo.remain + " reset=" + limitInfo.reset + "s" : "未触发");

  console.log("\n【订单簿（含缓存）】");
  const t0 = Date.now();
  const o1 = await F.fetchOrders(client, 10000002, 34, "sell");
  const t1 = Date.now();
  const o2 = await F.fetchOrders(client, 10000002, 34, "sell");
  const t2 = Date.now();
  ok(o1.length > 0, "订单簿", o1.length + " 条");
  if (o1.length) {
    ok(o1[0].price > 0 && o1[0].locationId > 0, "订单字段归一化",
      "价=" + o1[0].price + " 位置=" + o1[0].locationId);
    const sells = o1.filter(o => !o.isBuy);
    ok(sells.length > 0, "含卖单");
  }
  ok(t2 - t1 < 50, "二次调用走缓存", "首次 " + (t1 - t0) + "ms，二次 " + (t2 - t1) + "ms");

  console.log("\n【历史成交】");
  const h = await F.fetchHistory(client, 10000002, 34);
  ok(Array.isArray(h) && h.length > 100, "历史成交", h.length + " 天");
  if (h.length) {
    ok(h[0].date && h[0].average != null, "字段完整",
      h[0].date + " 均价=" + h[0].average);
  }

  console.log("\n【国服 vs 欧服 EIV 差异】");
  const eu = new EsiClient({ server: "tranquility" });
  const euEiv = await F.fetchEiv(eu);
  const cnEiv = eiv;
  const t18cn = cnEiv["18"], t18eu = euEiv["18"];
  ok(t18cn && t18eu, "两端均有 typeID 18");
  if (t18cn && t18eu) {
    ok(Math.abs(t18cn.adjusted - t18eu.adjusted) > 0.01, "两端 EIV 不同（数据独立）",
      "国服 " + t18cn.adjusted.toFixed(2) + " vs 欧服 " + t18eu.adjusted.toFixed(2));
  }
  ok(Object.keys(euEiv).length !== Object.keys(cnEiv).length, "两端 EIV 条目数不同",
    "欧服 " + Object.keys(euEiv).length + " vs 国服 " + Object.keys(cnEiv).length);

  console.log("\n" + "=".repeat(56));
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("异常:", e); process.exit(1); });
