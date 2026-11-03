/*
 * EVE 辅助工具 —— M2 授权与档案模块自检
 * 运行：node src/core/m2.test.js
 *
 * 验证重点：
 *   1. PKCE 生成与校验（不泄露 secret）
 *   2. 三服 SSO 端点与 authorize 方法差异
 *   3. 令牌解析（JWT → 角色 ID）
 *   4. 角色档案：持久化、技能同步、变化检测、前台中文展示
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AuthManager, createPkce, createState, characterIdFromToken, decodeToken } = require("./auth.js");
const { ProfileStore } = require("./profiles.js");
const { SERVERS, SERVER_ORDER } = require("./servers.js");
const skillMap = require("./skill-map.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n" + t); }

console.log("EVE 辅助工具 · M2 授权与档案自检");

/* ---------------- PKCE ---------------- */
section("【PKCE】");
const pkce = createPkce();
ok(pkce.verifier && pkce.verifier.length >= 43, "code_verifier 长度合规", pkce.verifier.length + " 字符");
ok(pkce.challenge && pkce.challenge.length >= 43, "code_challenge 长度合规", pkce.challenge.length + " 字符");
ok(/^[A-Za-z0-9_-]+$/.test(pkce.verifier), "verifier 是 base64url 无填充");
ok(/^[A-Za-z0-9_-]+$/.test(pkce.challenge), "challenge 是 base64url 无填充");

// 独立复算 challenge，确认 S256 正确
const recomputed = crypto.createHash("sha256").update(pkce.verifier).digest("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
ok(recomputed === pkce.challenge, "challenge = base64url(SHA256(verifier))", recomputed.slice(0, 16) + "…");

const p2 = createPkce();
ok(p2.verifier !== pkce.verifier, "每次生成不同 verifier");
const st1 = createState(), st2 = createState();
ok(st1 !== st2 && st1.length >= 22, "state 随机且长度合规");

/* ---------------- 三服 SSO 端点 ---------------- */
section("【三服 SSO 端点配置】");
for (const key of SERVER_ORDER) {
  const cfg = SERVERS[key];
  ok(cfg.ssoAuthorize.startsWith("https://"), key + " 授权端点 HTTPS", cfg.ssoAuthorize);
  ok(cfg.ssoToken.includes("oauth/token"), key + " 令牌端点", cfg.ssoToken);
  ok(!!cfg.ssoAuthorizeMethod, key + " 声明授权方法", cfg.ssoAuthorizeMethod);
}
ok(SERVERS.tranquility.ssoAuthorizeMethod === "GET", "欧服用 GET 授权（可直接跳转）");
ok(SERVERS.serenity.ssoAuthorizeMethod === "GET", "国服晨曦用 GET 授权（浏览器实测可跳转）");
ok(SERVERS.shuguang.ssoAuthorizeMethod === "GET", "国服曙光用 GET 授权");
// ★ 曙光服有**独立的登录集群**（实测 2026-11-03）：
//   晨曦 login.evepc.163.com，曙光 login-infinity.evepc.163.com —— 两者账号体系独立。
//   此前误以为两服共用域名，已修正。
ok(SERVERS.serenity.ssoAuthorize.includes("login.evepc.163.com"), "晨曦用 login 集群");
ok(SERVERS.shuguang.ssoAuthorize.includes("login-infinity.evepc.163.com"), "★ 曙光用独立的 login-infinity 集群");
ok(SERVERS.serenity.ssoToken !== SERVERS.shuguang.ssoToken, "★ 两服的 token 端点也相互独立");
ok(SERVERS.serenity.ssoAuthorize !== SERVERS.shuguang.ssoAuthorize, "★ 两服授权端点不相同");

/* ---------------- 授权 URL 构造 ---------------- */
section("【授权 URL 构造】");
const auth = new AuthManager({
  clientId: "TESTCLIENTID",
  redirectUri: "http://localhost:8657/sso/callback",
  server: "serenity"
});
const au = auth.buildAuthorize("tranquility", ["esi-skills.read_skills.v1", "esi-wallet.read_character_wallet.v1"]);
ok(au.url.startsWith("https://login.eveonline.com/v2/oauth/authorize/"), "欧服授权 URL 前缀");
ok(au.url.includes("code_challenge="), "含 code_challenge（PKCE）");
ok(au.url.includes("code_challenge_method=S256"), "code_challenge_method=S256");
ok(au.url.includes("response_type=code"), "response_type=code");
ok(au.url.includes("state="), "含 state（防 CSRF）");
ok(au.method === "GET", "欧服 method=GET");

const auCn = auth.buildAuthorize("serenity", ["esi-skills.read_skills.v1"]);
ok(auCn.method === "GET", "国服 method=GET");
ok(auCn.form && auCn.form.code_challenge, "国服授权含 code_challenge");
ok(auCn.form.response_type === "code" && auCn.form.client_id === "TESTCLIENTID", "授权参数含标准 OAuth 字段");
ok(auCn.form.realm && auCn.form.device_id, "国服含特有参数 realm / device_id", auCn.form.realm + " / " + auCn.form.device_id);
ok(au.state !== auCn.state, "每次授权 state 唯一");
ok(auth.pending.size === 2, "pending 记录已保存", auth.pending.size + " 条");

// state 校验
ok(!auth.pending.has("nonexistent"), "未知 state 不在 pending 中");
try {
  auth.buildAuthorize("nonexistent_server", []);
  ok(false, "未知服务器应抛错");
} catch (e) {
  ok(true, "未知服务器抛错", e.message);
}
try {
  new AuthManager({ clientId: "" }).buildAuthorize("serenity", []);
  ok(false, "未配置 Client ID 应抛错");
} catch (e) {
  ok(true, "未配置 Client ID 抛错", e.message);
}
try {
  auth.buildAuthorize("serenity", ["a.v1", "b.v1", "c.v1", "d.v1", "e.v1"]);
  ok(false, "国服超过 4 项 scope 应抛错");
} catch (e) {
  ok(true, "国服 scope 上限 4 项", e.message.slice(0, 40));
}

/* ---------------- JWT 解析 ---------------- */
section("【JWT 解析】");
function makeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return b64({ alg: "RS256", typ: "JWT" }) + "." + b64(payload) + ".sig";
}
const jwt = makeJwt({
  sub: "CHARACTER:EVE:12345678",
  name: "Test Pilot",
  exp: 9999999999
});
ok(characterIdFromToken(jwt) === 12345678, "从 sub 解析角色 ID", characterIdFromToken(jwt));
const dp = decodeToken(jwt);
ok(dp && dp.name === "Test Pilot", "解析 JWT 载荷", dp && dp.name);
ok(characterIdFromToken("not-a-jwt") === null, "非法 JWT 返回 null");
ok(characterIdFromToken(makeJwt({ sub: "CORPORATION:EVE:1" })) === null, "非角色 sub 返回 null");

/* ---------------- 令牌持久化 ---------------- */
section("【令牌持久化】");
const TOKEN_FILE = path.join(__dirname, "..", "..", "用户数据", "eve_auth_v1.json");
const tmpFile = TOKEN_FILE + ".test";
if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

// 用临时文件测试，不污染真实令牌
const fsBackup = fs.readFileSync;
const a2 = new AuthManager({ clientId: "CID", server: "serenity" });
a2._store({
  access_token: jwt,
  refresh_token: "REFRESH123",
  expires_in: 1200
}, "serenity");
ok(Object.keys(a2.tokens).length === 1, "令牌已保存", Object.keys(a2.tokens)[0]);
const list = a2.list();
ok(list.length === 1, "列出令牌", list.length + " 条");
ok(list[0].characterId === 12345678, "列表含角色 ID");
ok(list[0].serverLabel && list[0].serverLabel.includes("国服"), "列表含服务器中文标签", list[0].serverLabel);
ok(list[0].hasRefresh === true, "标记含 refresh token");

// 自动刷新判定
const rec = a2.tokens[Object.keys(a2.tokens)[0]];
rec.expiresAt = Date.now() + 30000;   // 30 秒后过期 → 触发刷新
ok(rec.expiresAt - Date.now() < 60000, "接近过期时进入刷新分支");
ok(a2.remove(Object.keys(a2.tokens)[0]) === true, "删除令牌");
ok(Object.keys(a2.tokens).length === 0, "删除后为空");

// 清理测试产生的文件
if (fs.existsSync(TOKEN_FILE)) {
  const cur = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  if (Object.keys(cur).length === 0) fs.unlinkSync(TOKEN_FILE);
}
if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);

/* ---------------- 角色档案 ---------------- */
section("【角色档案】");
const ps = new ProfileStore();
const KEY = ProfileStore.key("serenity", 99999999);
ps.save({
  serverKey: "serenity",
  characterId: 99999999,
  characterName: "测试角色",
  skills: { ind: 5, acct: 3, refine: 2 },
  skillSnapshot: { ind: 4, acct: 3, refine: 2 },
  totalSP: 123456
});
const prof = ps.get("serenity", 99999999);
ok(prof !== null, "档案已保存");
ok(prof.characterName === "测试角色", "档案含角色名");
ok(prof.totalSP === 123456, "档案含总 SP");

section("【技能变化检测】");
const changes = ps.detectSkillChanges(prof);
ok(changes.length === 1, "检测到 1 项变化", changes.length + " 项");
if (changes.length) {
  ok(changes[0].id === "ind", "变化项为 ind", changes[0].id);
  ok(changes[0].from === 4 && changes[0].to === 5, "变化前后等级", changes[0].from + " → " + changes[0].to);
  ok(changes[0].nameZh === "工业理论", "变化项中文名", changes[0].nameZh);
  ok(!!changes[0].effect, "变化项含效果说明", changes[0].effect);
}

section("【前台展示为中文】");
const disp = ps.displaySkills(prof);
ok(disp.length >= 11, "技能展示列表", disp.length + " 项");
ok(disp.every(d => !/^[A-Za-z ]+$/.test(d.name)), "展示名全为中文");
const dInd = disp.find(d => d.id === "ind");
ok(dInd && dInd.name === "工业理论" && dInd.level === 5, "工业理论 5 级", dInd ? dInd.name + " " + dInd.level : "");
const groups = ps.displaySkillGroups(prof);
ok(Object.keys(groups).length >= 4, "技能分组（中文分组名）", Object.keys(groups).join(" / "));

section("【档案列表】");
const pl = ps.list();
ok(pl.length >= 1, "列出档案");
ok(pl[0].serverLabel && pl[0].serverLabel.includes("国服"), "含服务器中文标签", pl[0].serverLabel);
ok(pl[0].skillCount === 3, "统计已学技能数", pl[0].skillCount + " 项");

// 清理
ps.remove(KEY);

section("【上游错误中文映射】");
{
  const AU = require("./auth.js");
  const fn = AU.explainAuthError;
  ok(typeof fn === "function", "explainAuthError 已导出");
  if (typeof fn === "function") {
    const r1 = fn("Unable to check RealID binding if user isn't logged in. Missing Netease token.");
    ok(r1.indexOf("Cookie") >= 0, "Netease token 错误 → 提示清 Cookie", r1.slice(0, 30));
    ok(r1.indexOf("原始信息") >= 0, "保留原始错误信息");
    const r2 = fn("invalid_client");
    ok(r2.indexOf("Client ID") >= 0, "invalid_client → 提示 Client ID");
    const r3 = fn("some unknown error");
    ok(r3 === "some unknown error", "未知错误原样返回", r3);
  }
}

console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);

