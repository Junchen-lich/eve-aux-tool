/*
 * ESI 客户端端到端实测 —— 三服各跑真实请求
 * 运行：node src/core/esi-client.test.js
 */
"use strict";

const { EsiClient } = require("./esi-client.js");
const { SERVERS, SERVER_ORDER } = require("./servers.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}

async function main() {
  console.log("三服 ESI 客户端连通性实测\n" + "=".repeat(58));

  for (const key of SERVER_ORDER) {
    const cfg = SERVERS[key];
    console.log("\n【" + cfg.label + "】" + cfg.esiBase);
    const c = new EsiClient({ server: key });

    // 1) 服务器状态
    try {
      const st = await c.getStatus();
      ok(st && st.server_version != null, "状态接口",
        "版本=" + st.server_version + " 玩家=" + st.players);
    } catch (e) { ok(false, "状态接口", e.message); }

    // 2) 市场订单
    try {
      const orders = await c.getMarketOrders(10000002, "sell", 34);
      const arr = Array.isArray(orders) ? orders : (orders && orders.data) || [];
      ok(arr.length > 0, "市场订单 type_id=34", arr.length + " 条");
      if (arr.length) {
        const o = arr[0];
        ok(o.price > 0 && o.location_id > 0, "订单字段完整",
          "价=" + o.price + " 位置=" + o.location_id);
      }
    } catch (e) { ok(false, "市场订单", e.message); }

    // 3) 历史成交
    try {
      const h = await c.getMarketHistory(10000002, 34);
      ok(Array.isArray(h) && h.length > 0, "历史成交", h.length + " 天");
    } catch (e) { ok(false, "历史成交", e.message); }

    // 4) 公开合同（只取第 1 页，控制耗时）
    try {
      const res = await c.request("/contracts/public/10000002/", { page: 1 }, { auth: false });
      const arr = Array.isArray(res) ? res : (res && res.data) || [];
      ok(arr.length > 0, "公开合同 第1页", arr.length + " 条");
    } catch (e) { ok(false, "公开合同", e.message); }

    // 5) 调整后价格 EIV（大响应，只验结构）
    try {
      const p = await c.getAdjustedPrices();
      ok(Array.isArray(p) && p.length > 0 && p[0].adjusted_price != null,
        "EIV 调整后价格", (p ? p.length : 0) + " 条");
    } catch (e) { ok(false, "EIV", e.message); }

    // 6) 工业成本指数
    try {
      const s = await c.getIndustrySystems();
      ok(Array.isArray(s) && s.length > 0 && s[0].cost_indices != null,
        "工业成本指数", (s ? s.length : 0) + " 个星系");
    } catch (e) { ok(false, "工业成本指数", e.message); }

    // 7) 批量 ID 解析（POST + 裸数组）
    try {
      const ids = await c.resolveIds([34, 1405]);
      const cats = Object.keys(ids || {});
      ok(cats.length > 0, "批量 ID 解析", "返回类别: " + cats.join(","));
    } catch (e) { ok(false, "批量 ID 解析", e.message); }

    // 8) 未授权时应明确报错
    try {
      await c.getSkills(2114794365);
      ok(false, "无令牌访问技能应失败", "竟然成功了（不应）");
    } catch (e) {
      ok(e.code === "UNAUTHORIZED", "无令牌访问技能返回 401", e.code || e.message);
    }
  }

  // 9) URL 构造：数组参数必须是重复参数
  console.log("\n【URL 构造规则】");
  const c = new EsiClient({ server: "tranquility" });
  const u1 = c.buildUrl("/markets/10000002/orders/", { order_type: "sell", type_id: [34, 35] });
  ok(/type_id=34&type_id=35/.test(u1) && !/type_id=34%2C35/.test(u1),
    "数组参数用重复参数而非逗号", u1.replace("https://esi.evetech.net/latest", ""));
  const u2 = c.buildUrl("/markets/10000002/orders/", { order_type: "sell" });
  ok(u2.includes("datasource=tranquility"), "欧服自动带 datasource");
  const c3 = new EsiClient({ server: "serenity" });
  const u3 = c3.buildUrl("/status/", null);
  ok(!u3.includes("datasource"), "国服不带 datasource", u3.replace("https://ali-esi.evepc.163.com/latest", ""));

  console.log("\n" + "=".repeat(58));
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("意外异常:", e); process.exit(1); });
