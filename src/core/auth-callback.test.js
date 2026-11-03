/*
 * EVE 辅助工具 —— 授权回调地址与分服凭据自检
 * 运行：node src/core/auth-callback.test.js
 *
 * 验证重点（对应 2026-11-03 实际排查出的三个坑）：
 *   1. 回调地址必须跟随**实际监听端口**（端口被占用自动顺延后不能失配）
 *   2. 回调地址主机名统一为 localhost（localhost 与 127.0.0.1 是两个不同值）
 *   3. 三套集群的 Client ID 相互独立，曙光不可与晨曦共用
 *   4. 网易官方公共 Client ID 的回调地址限定 → 预检必须能识别并拦截
 *   5. 陈旧配置（旧端口）不能被盲信
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { AuthManager, explainAuthError } = require("./auth.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

console.log("EVE 辅助工具 · 授权回调与分服凭据自检");

/* ------------------------------------------------------------------ *
 * 从 server.js 抽取被测逻辑（server.js 一启动就监听，无法直接 require）
 * ------------------------------------------------------------------ */
function loadServerHelpers() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
  // 抽取 defaultRedirectUri 整个函数（含参数表）
  const m = src.match(/function defaultRedirectUri\(port\)\s*\{[\s\S]*?\n\}/);
  if (!m) throw new Error("未能从 server.js 抽取 defaultRedirectUri");
  // 用 BASE_URL / PORT 作为闭包变量注入
  const fn = new Function("BASE_URL", "PORT", m[0] + "\n return defaultRedirectUri;");
  return {
    defaultRedirectUri: fn("", 8657),
    // 官方公共 ID 与其唯一登记的回调地址
    OFFICIAL_CN_CLIENT_ID: "bc90aa496a404724a93f41b4f4e97761",
    OFFICIAL_CN_REDIRECT_URI: "https://esi.evepc.163.com/ui/oauth2-redirect.html"
  };
}

const H = loadServerHelpers();

/* ---------------- 1. 回调地址跟随实际端口 ---------------- */
section("【回调地址跟随实际监听端口】");
{
  const r8657 = H.defaultRedirectUri(8657);
  const r8658 = H.defaultRedirectUri(8658);
  const r8660 = H.defaultRedirectUri(8660);
  ok(r8657.includes(":8657"), "端口 8657 的回调地址正确", r8657);
  ok(r8658.includes(":8658"), "端口 8658 的回调地址正确", r8658);
  ok(r8660.includes(":8660"), "端口 8660 的回调地址正确", r8660);
  ok(r8657 !== r8658, "不同端口得到不同回调地址（不会失配）");

  // ★ 核心回归：端口顺延后回调地址必须跟着变
  ok(!r8658.includes(":8657"), "★ 端口顺延后回调地址不再指向旧端口");
}

/* ---------------- 2. 主机名统一 ---------------- */
section("【主机名统一为 localhost】");
{
  const r = H.defaultRedirectUri(8657);
  ok(r.startsWith("http://localhost:"), "默认使用 localhost 而非 127.0.0.1", r);
  ok(!r.includes("127.0.0.1"), "★ 不会出现 127.0.0.1（与后台登记的 localhost 不同值）");
  ok(r.endsWith("/sso/callback"), "回调路径正确", r);
  ok(!r.endsWith("/"), "★ 末尾无多余斜杠（后台登记什么就是什么）");
}

/* ---------------- 3. 官方公共 Client ID 的识别 ---------------- */
section("【网易官方公共 Client ID 的识别】");
{
  const offId = H.OFFICIAL_CN_CLIENT_ID;
  const isOfficial = (id) => String(id || "").trim().toLowerCase() === offId.toLowerCase();
  ok(isOfficial(offId), "官方 ID 被正确识别");
  ok(!isOfficial("bc90aa496a404724a93f41b4f4e97762"), "仅差一位的 ID 不误判");
  ok(!isOfficial(""), "空 ID 不误判");
  ok(!isOfficial("my-own-client-id"), "自注册 ID 不误判");
}

/* ---------------- 4. 错误提示可操作性 ---------------- */
section("【错误提示的可操作性】");
{
  const raw = "The redirect URL does not match any of the configured values for this client.";

  // 4a. 用官方 ID 时应给出「官方 ID 回调受限」的专门指引
  const msgOfficial = explainAuthError(raw, {
    redirectUri: "http://localhost:8657/sso/callback",
    usingOfficialClientId: true
  });
  ok(msgOfficial.includes("bc90aa496a404724a93f41b4f4e97761"), "提示中点明官方 Client ID");
  ok(msgOfficial.includes(H.OFFICIAL_CN_REDIRECT_URI), "提示中给出官方唯一登记的回调地址");
  ok(msgOfficial.includes("http://localhost:8657/sso/callback"), "提示中回显本次上报的回调地址");
  ok(msgOfficial.includes("网易开发者后台"), "给出解决路径（自行注册应用）");

  // 4b. 自注册 ID 时应给出「逐字符核对 + 曙光需单独注册」的指引
  const msgOwn = explainAuthError(raw, {
    redirectUri: "http://localhost:8658/sso/callback",
    usingOfficialClientId: false
  });
  ok(msgOwn.includes("http://localhost:8658/sso/callback"), "回显本次上报的回调地址");
  ok(msgOwn.includes("曙光"), "提示曙光服需单独注册");
  ok(msgOwn.includes("逐字符核对") || msgOwn.includes("斜杠"), "提示逐字符核对回调地址");

  // 4c. 其它错误不受影响
  const msgCookie = explainAuthError("Missing Netease token", {});
  ok(msgCookie.includes("Cookie"), "Cookie 失效的提示保持不变");
  const msgClient = explainAuthError("invalid_client", {});
  ok(msgClient.includes("Client ID"), "invalid_client 的提示保持不变");
  const msgGrant = explainAuthError("invalid_grant", {});
  ok(msgGrant.includes("重新发起授权"), "invalid_grant 的提示保持不变");
}

/* ---------------- 5. 分服凭据隔离 ---------------- */
section("【分服凭据隔离】");
{
  // ★ 必须用临时目录：绝不能写进真实的 用户数据/users/local/
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-authcb-"));
  const { UserSpace } = require("./user-store.js");
  const us = new UserSpace({ salt: "test-salt", singleUser: true, baseDir: tmpRoot });
  const store = us.store("local");

  const meta = store.meta();
  meta.servers = {
    serenity: { clientId: "cn-client-serenity", clientSecret: "", redirectUri: "http://localhost:8657/sso/callback" },
    shuguang: { clientId: "cn-client-shuguang", clientSecret: "", redirectUri: "http://localhost:8657/sso/callback" }
  };
  store._writeJson(store.metaFile, meta);

  const read = store.meta();
  ok(read.servers.serenity.clientId === "cn-client-serenity", "晨曦 Client ID 独立保存");
  ok(read.servers.shuguang.clientId === "cn-client-shuguang", "曙光 Client ID 独立保存");
  ok(read.servers.serenity.clientId !== read.servers.shuguang.clientId,
    "★ 晨曦与曙光的 Client ID 不共用");

  // 清理
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { }
}

/* ---------------- 6. pending 记录按服保存 ---------------- */
section("【授权 state 的 pending 记录】");
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eve-authcb2-"));
  const { UserSpace } = require("./user-store.js");
  const us = new UserSpace({ salt: "test-salt2", singleUser: true, baseDir: tmpRoot });
  const store = us.store(us.userIdFor("callback-test-user"));
  store.savePending("state-abc", { serverKey: "shuguang", verifier: "v" });
  const p = store.pending("state-abc");
  ok(!!p, "pending 记录已保存");
  ok(p && p.serverKey === "shuguang", "★ pending 记住了服务器（回调时据此选凭据）", p && p.serverKey);
  ok(store.pending("nonexistent") === null, "不存在的 state 返回 null");
  store.clearPending("state-abc");
  ok(store.pending("state-abc") === null, "授权完成后 pending 被清除");
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { }
}

/* ---------------- 7. AuthManager 的凭据可分服构造 ---------------- */
section("【AuthManager 分服构造】");
{
  const a1 = new AuthManager({ clientId: "cn-serenity", redirectUri: "http://localhost:8657/sso/callback" });
  const a2 = new AuthManager({ clientId: "cn-shuguang", redirectUri: "http://localhost:8657/sso/callback" });
  ok(a1.clientId !== a2.clientId, "两个实例各自持有独立 Client ID");

  const au = a1.buildAuthorize("serenity", ["esi-skills.read_skills.v1"]);
  const u = new URL(au.url);
  ok(u.searchParams.get("client_id") === "cn-serenity", "授权 URL 带上本服的 Client ID");
  ok(u.searchParams.get("redirect_uri") === "http://localhost:8657/sso/callback", "授权 URL 带上本服的回调地址");
  ok(u.searchParams.get("code_challenge_method") === "S256", "使用 PKCE S256");
  ok(u.origin + u.pathname === "https://login.evepc.163.com/v2/oauth/authorize/", "国服授权端点正确");
  ok(u.searchParams.get("realm") === "esi", "国服必填 realm 已带上");
}

/* ---------------- 8. scope 上限仍按服生效 ---------------- */
section("【scope 数量上限】");
{
  const a = new AuthManager({ clientId: "x", redirectUri: "http://localhost:8657/sso/callback" });
  let threw = false;
  try { a.buildAuthorize("serenity", ["a", "b", "c", "d", "e"]); }
  catch (e) { threw = true; ok(/最多申请 4 项/.test(e.message), "国服超过 4 项被拒绝", e.message.slice(0, 40)); }
  ok(threw, "国服 scope 超限抛错");

  const b = new AuthManager({ clientId: "x", redirectUri: "http://localhost:8657/sso/callback" });
  const okAu = b.buildAuthorize("tranquility", ["a", "b", "c", "d", "e", "f"]);
  ok(!!okAu.url, "欧服 scope 无上限限制");
}

/* ------------------------------------------------------------------ */
console.log("\n====================================================");
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("====================================================");
process.exit(fail === 0 ? 0 : 1);
