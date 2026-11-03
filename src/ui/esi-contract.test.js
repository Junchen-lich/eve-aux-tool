/*
 * ESI 响应字段契约测试
 *
 * 目的：防止前端把 ESI 的字段名写错。
 *   ★ 实际踩过的坑：
 *     - 把 is_buy_order 写成 is_sell_order → 卖单全部归入买单（卖单显示 0 条）
 *     - 把 volume_remain / volume_total 写成 remaining / volume → 列全显示 —
 *     - 把历史成交的 average / volume 写成 average_price / total_volume
 *
 * 做法：真实调用 ESI 各端点，校验字段名与类型。
 *       需联网。
 */
"use strict";

const http = require("http");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n【" + t + "】"); }

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1", port: 8657, path: path,
      headers: { "User-Agent": "EVE-AuxTool/0.1" }
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("非 JSON：" + d.slice(0, 120))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(60000, () => req.destroy(new Error("超时")));
  });
}

/* ------------------------------------------------------------------ *
 * 订单：is_buy_order / volume_remain / volume_total
 * ------------------------------------------------------------------ */
(async function () {
section("【市场订单字段契约】");
{
  const orders = await get("/esi/serenity/markets/10000002/orders/?type_id=34");
  ok(Array.isArray(orders) && orders.length > 0, "订单接口返回数组", orders.length + " 条");

  const o = orders[0];
  ok("is_buy_order" in o, "★ 字段是 is_buy_order（不是 is_sell_order）");
  ok(!("is_sell_order" in o), "★ 不存在 is_sell_order（写它会恒为 undefined）");
  ok(typeof o.is_buy_order === "boolean", "is_buy_order 是布尔型", String(o.is_buy_order));
  ok("volume_remain" in o, "★ 字段是 volume_remain（不是 remaining）");
  ok(!("remaining" in o), "★ 不存在 remaining");
  ok("volume_total" in o, "★ 字段是 volume_total（不是 volume）");
  ok(typeof o.price === "number", "price 是数值型", String(o.price));
  ok(typeof o.location_id === "number", "location_id 是数值型", String(o.location_id));

  // 买卖分布合理性：两类都应存在
  const buys = orders.filter(x => x.is_buy_order === true).length;
  const sells = orders.filter(x => x.is_buy_order === false).length;
  ok(buys > 0 && sells > 0, "买卖单两类都非空", "买 " + buys + " / 卖 " + sells);
}

/* ------------------------------------------------------------------ *
 * 历史成交：average / lowest / highest / volume / order_count
 * ------------------------------------------------------------------ */
section("【历史成交字段契约】");
{
  const rows = await get("/esi/serenity/markets/10000002/history/?type_id=34");
  ok(Array.isArray(rows) && rows.length > 0, "历史接口返回数组", rows.length + " 条");

  const r = rows[0];
  ok("average" in r, "★ 字段是 average（不是 average_price）");
  ok(!("average_price" in r), "★ 不存在 average_price");
  ok("lowest" in r, "字段是 lowest（不是 lowest_price）");
  ok("highest" in r, "字段是 highest（不是 highest_price）");
  ok("volume" in r, "★ 字段是 volume（不是 total_volume）");
  ok(!("total_volume" in r), "★ 不存在 total_volume");
  ok("order_count" in r, "字段是 order_count");
  ok("date" in r, "字段是 date");
  ok(typeof r.average === "number", "average 是数值型", String(r.average));
}

/* ------------------------------------------------------------------ *
 * EIV 基准价：{ adjusted, average }
 * ------------------------------------------------------------------ */
section("【EIV 基准价字段契约】");
{
  const eiv = await get("/api/eiv?server=serenity");
  ok(eiv.ok === true, "EIV 接口可用", eiv.count + " 条");
  const keys = Object.keys(eiv.prices || {});
  ok(keys.length > 0, "含价格数据");
  const first = eiv.prices[keys[0]];
  ok(typeof first === "object" && "adjusted" in first && "average" in first,
    "★ EIV 条目形如 { adjusted, average }", JSON.stringify(first));
  ok(typeof first.average === "number" && first.average > 0, "average 为正数", String(first.average));
}

/* ------------------------------------------------------------------ *
 * 界面侧的解析约定（与 app.js 保持一致）
 * ------------------------------------------------------------------ */
section("【界面解析约定一致性】");
{
  const fs = require("fs");
  const path = require("path");
  const raw = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
  /* 去掉注释后再检查 —— 注释里可以自由提及错误字段名以作说明 */
  const app = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  ok(app.indexOf("is_sell_order") < 0, "★ app.js 代码中不出现 is_sell_order");
  ok(app.indexOf("is_buy_order === false") >= 0, "app.js 用 is_buy_order===false 判定卖单");
  ok(app.indexOf("o.volume_remain") >= 0, "app.js 用 volume_remain");
  ok(app.indexOf("o.volume_total") >= 0, "app.js 用 volume_total");
  ok(app.indexOf("r.average_price") < 0, "★ app.js 代码中不出现 r.average_price");
  ok(app.indexOf("r.average)") >= 0 || app.indexOf("r.average ") >= 0, "app.js 用 r.average");
  ok(app.indexOf("r.total_volume") < 0, "★ app.js 代码中不出现 r.total_volume");
  ok(app.indexOf("r.volume)") >= 0 || app.indexOf("r.volume ") >= 0, "app.js 用 r.volume");
}

console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
})();
