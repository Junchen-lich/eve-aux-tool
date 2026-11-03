/*
 * EVE 辅助工具 —— 服务端路由自检
 * 运行：node src/core/server-routes.test.js
 *
 * 验证重点：
 *   1. 首页带查询串不能 404（`/?openpanel=1` 这类链接）
 *   2. 静态资源（app.js / css / 数据表）正常返回
 *   3. 手动授权接口的行为
 */
"use strict";

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

console.log("EVE 辅助工具 · 服务端路由自检");

/** 发一个请求，返回 { code, body, headers } */
function req(port, urlPath, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: "127.0.0.1", port, path: urlPath, method: method || "GET",
      headers: data
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
        : {}
    }, (res) => {
      let b = "";
      res.on("data", (c) => b += c);
      res.on("end", () => resolve({ code: res.statusCode, body: b, headers: res.headers }));
    });
    r.on("error", (e) => resolve({ code: 0, body: e.message, headers: {} }));
    if (data) r.write(data);
    r.end();
  });
}

/** 启动服务，返回 { proc, port } */
function startServer() {
  return new Promise((resolve, reject) => {
    // 用一个大概率空闲的高位端口
    const proc = spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: "18777", EVE_MULTI_USER: "0" }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let buf = "";
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 15000);
    proc.stdout.on("data", (c) => {
      buf += c.toString();
      const m = buf.match(/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, port: Number(m[1]) });
      }
    });
    proc.on("error", reject);
  });
}

(async function main() {
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    console.log("  FAIL 无法启动服务 → " + e.message);
    process.exit(1);
  }
  const port = srv.port;
  console.log("  （测试服务端口 " + port + "）");

  /* ---------------- 首页 ---------------- */
  section("【首页】");
  {
    const r = await req(port, "/");
    ok(r.code === 200, "首页返回 200", "HTTP " + r.code);
    ok(r.body.includes("<title>EVE 辅助工具</title>"), "首页是正确页面");
  }

  /* ---------------- ★ 带查询串的首页（本次修复的 bug） ---------------- */
  section("【带查询串的首页】");
  {
    const r = await req(port, "/?openpanel=1");
    ok(r.code === 200, "★ /?参数 不再 404", "HTTP " + r.code);
    ok(r.body.includes("<title>EVE 辅助工具</title>"), "返回的仍是首页内容");
    const r2 = await req(port, "/?a=1&b=2");
    ok(r2.code === 200, "多个查询参数也正常", "HTTP " + r2.code);
    const r3 = await req(port, "/index.html?v=2");
    ok(r3.code === 200, "/index.html?v=2 正常", "HTTP " + r3.code);
  }

  /* ---------------- 静态资源 ---------------- */
  section("【静态资源】");
  {
    const js = await req(port, "/src/ui/app.js");
    ok(js.code === 200, "app.js 可访问", "HTTP " + js.code);
    ok(js.body.includes("openManualPanel"), "app.js 是最新版本");
    ok(
      /no-store/.test(js.headers["cache-control"] || ""),
      "★ 静态资源用 no-store（避免浏览器用旧副本）",
      js.headers["cache-control"]
    );
    const css = await req(port, "/src/ui/style.css");
    ok(css.code === 200, "style.css 可访问");
    const data = await req(port, "/data/sde/tax_config.json");
    ok(data.code === 200, "数据表可访问");
  }

  /* ---------------- 手动授权接口 ---------------- */
  section("【手动授权接口】");
  {
    const link = await req(port, "/api/auth/manual?server=shuguang&scope=esi-skills.read_skills.v1&mode=code");
    ok(link.code === 200, "生成授权链接返回 200", "HTTP " + link.code);
    let j = {};
    try { j = JSON.parse(link.body); } catch (e) { }
    ok(j.ok === true, "响应 ok=true");
    ok(typeof j.url === "string" && j.url.indexOf("login-infinity") >= 0,
      "★ 曙光服走独立的 login-infinity 集群");
    ok(j.url && j.url.indexOf("code_challenge") >= 0, "授权码流程带 PKCE");
    ok(j.url && j.url.indexOf("response_type=code") >= 0, "response_type=code");

    const link2 = await req(port, "/api/auth/manual?server=shuguang&scope=esi-skills.read_skills.v1&mode=token");
    let j2 = {};
    try { j2 = JSON.parse(link2.body); } catch (e) { }
    ok(j2.url && j2.url.indexOf("response_type=token") >= 0, "隐式流程 response_type=token");
    ok(j2.url && j2.url.indexOf("code_challenge") < 0, "隐式流程不带 code_challenge");

    // 粘贴授权链接（误操作）→ 应报「你粘贴的是授权链接」
    const bad = await req(port, "/api/auth/manual", "POST", {
      serverKey: "shuguang",
      pasted: j.url
    });
    ok(bad.code === 400, "误粘贴授权链接返回 400", "HTTP " + bad.code);
    let je = {};
    try { je = JSON.parse(bad.body); } catch (e) { }
    ok((je.error || "").indexOf("授权链接") >= 0, "★ 识别出「粘贴的是授权链接」");

    // 空内容
    const empty = await req(port, "/api/auth/manual", "POST", { serverKey: "shuguang", pasted: "" });
    ok(empty.code === 400, "空内容返回 400");
  }

  /* ---------------- 其它接口不应 404 ---------------- */
  section("【其它接口】");
  {
    const cfg = await req(port, "/api/config");
    ok(cfg.code === 200, "/api/config 正常", "HTTP " + cfg.code);
    const health = await req(port, "/healthz");
    ok(health.code === 200, "/healthz 正常");
    const notFound = await req(port, "/api/nonexistent");
    ok(notFound.code === 404, "不存在的接口返回 404", "HTTP " + notFound.code);
  }

  /* ---------------- 收尾 ---------------- */
  try { srv.proc.kill(); } catch (e) { }
  console.log("\n====================================================");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  console.log("====================================================");
  process.exit(fail === 0 ? 0 : 1);
})();
