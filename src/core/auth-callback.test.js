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
const { AuthManager, explainAuthError, isOfficialClientId, OFFICIAL_CN_CLIENT_ID, OFFICIAL_CN_REDIRECT_URI } = require("./auth.js");

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
    OFFICIAL_CN_CLIENT_ID: OFFICIAL_CN_CLIENT_ID,
    OFFICIAL_CN_REDIRECT_URI: OFFICIAL_CN_REDIRECT_URI
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
  ok(u.searchParams.get("realm") === "ESI", "国服必填 realm 已带上");
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

/* ---------------- 9. 手动授权通道（公共 Client ID） ---------------- */
section("【手动授权通道】");

/**
 * 手动通道涉及网络与异步解析，整段放进 async 函数并在末尾 await，
 * 否则进程会在断言执行完之前就退出 —— 表现为「测试静默跳过」。
 */
async function testManualChannel() {
  const a = new AuthManager({
    clientId: OFFICIAL_CN_CLIENT_ID,
    redirectUri: OFFICIAL_CN_REDIRECT_URI
  });

  // 9a. 生成授权链接（授权码流程）
  const au = a.buildManualAuthorize("shuguang", ["esi-skills.read_skills.v1"], {
    clientId: OFFICIAL_CN_CLIENT_ID,
    redirectUri: OFFICIAL_CN_REDIRECT_URI,
    usePkce: true
  });
  const u = new URL(au.url);
  ok(au.mode === "code", "授权码流程 mode=code");
  ok(u.searchParams.get("client_id") === OFFICIAL_CN_CLIENT_ID, "链接带公共 Client ID");
  ok(u.searchParams.get("redirect_uri") === OFFICIAL_CN_REDIRECT_URI, "链接带官方落地页回调地址");
  ok(u.searchParams.get("code_challenge") && u.searchParams.get("code_challenge_method") === "S256",
    "授权码流程带 PKCE S256");
  ok(u.searchParams.get("realm") === "ESI", "带国服必填 realm");
  ok(u.searchParams.get("device_id"), "带 device_id");
  ok(u.host === "login-infinity.evepc.163.com", "★ 曙光走独立的 login-infinity 集群", u.host);

  // 9b. 晨曦走 login 集群
  const au2 = a.buildManualAuthorize("serenity", ["esi-skills.read_skills.v1"], {
    clientId: OFFICIAL_CN_CLIENT_ID, usePkce: true
  });
  ok(new URL(au2.url).host === "login.evepc.163.com", "★ 晨曦走 login 集群");

  // 9c. 隐式流程（不需 PKCE）
  const au3 = a.buildManualAuthorize("shuguang", ["esi-skills.read_skills.v1"], {
    clientId: OFFICIAL_CN_CLIENT_ID, usePkce: false
  });
  const u3 = new URL(au3.url);
  ok(au3.mode === "token", "隐式流程 mode=token");
  ok(u3.searchParams.get("response_type") === "token", "response_type=token");
  ok(!u3.searchParams.get("code_challenge"), "隐式流程不带 code_challenge");

  // 9d. 粘贴解析：隐式流程
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-manual-"));
  const b = new AuthManager({
    clientId: OFFICIAL_CN_CLIENT_ID,
    redirectUri: OFFICIAL_CN_REDIRECT_URI,
    store: new (require("./user-store.js").UserSpace)({ salt: "s", singleUser: true, baseDir: tmpDir }).store("local")
  });
  const out = await (b.completeManual(
    "https://ali-esi.evepc.163.com/ui/oauth2-redirect.html#access_token=FAKE.TOKEN.VALUE&expires_in=1200&token_type=Bearer",
    "shuguang"
  ));
  ok(out.rec.source === "manual-implicit", "隐式流程被正确识别");
  ok(out.rec.accessToken === "FAKE.TOKEN.VALUE", "令牌已取出");
  ok(!!out.warning && out.warning.includes("不签发 refresh_token"), "提示了无 refresh_token 的后果");
  ok(out.warning.includes("保留在本地"), "★ 提示了数据会保留在本地");

  // 9e. 粘贴解析：裸片段
  const b2 = new AuthManager({
    clientId: OFFICIAL_CN_CLIENT_ID,
    store: new (require("./user-store.js").UserSpace)({ salt: "s2", singleUser: true, baseDir: tmpDir }).store("local")
  });
  const out2 = await (b2.completeManual("#access_token=BARE.TOKEN&expires_in=1200", "serenity"));
  ok(out2.rec.source === "manual-implicit", "裸片段也能解析");

  // 9f. 粘贴解析：上游 JSON 错误
  const b3 = new AuthManager({ clientId: OFFICIAL_CN_CLIENT_ID });
  let errMsg = "";
  try {
    await (b3.completeManual('{"error":"invalid_request","error_description":"redirect mismatch"}', "shuguang"));
  } catch (e) { errMsg = e.message; }
  ok(errMsg.includes("redirect mismatch"), "上游 JSON 错误被原样报出", errMsg.slice(0, 40));

  // 9g. 空内容
  let err2 = "";
  try { await (b3.completeManual("", "shuguang")); } catch (e) { err2 = e.message; }
  ok(err2.includes("请粘贴"), "空内容给出明确提示");

  // 9h. ★ 误把授权链接本身粘回来（实测最常见的误操作）
  const authLink = "https://login-infinity.evepc.163.com/v2/oauth/authorize/?" +
    "response_type=code&client_id=" + OFFICIAL_CN_CLIENT_ID +
    "&redirect_uri=https%3A%2F%2Fali-esi.evepc.163.com%2Fui%2Foauth2-redirect.html" +
    "&scope=esi-skills.read_skills.v1&state=TESTSTATE" +
    "&realm=ESI&device_id=eve-aux-tool" +
    "&code_challenge=LYToqXjKu8kK18VZ087fFQTEMAxLuvTxA9uAgY4YdAI&code_challenge_method=S256";
  let err3 = "";
  try { await (b3.completeManual(authLink, "shuguang")); } catch (e) { err3 = e.message; }
  ok(err3.includes("授权链接"), "★ 识别出「粘贴的是授权链接」", err3.split("\n")[0].slice(0, 30));
  ok(err3.includes("授权结果"), "指出正确的是什么");
  ok(err3.includes("ali-esi.evepc.163.com"), "给出正确地址的域名");
  ok(err3.includes("无痕"), "★ 给出了绕开失效 Cookie 的办法（无痕窗口）");
  ok(err3.includes("Missing Netease token"), "点明了失效 Cookie 的典型报错");
  ok(err3.includes("login-infinity"), "提示曙光服的独立登录集群");

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
}

/* ---------------- 11. pending 跨请求存活（PKCE verifier） ---------------- */
section("【pending 跨请求存活】");

/**
 * 跨请求 pending 的验证必须放在 async 函数里 ——
 * 顶层 await 在 CommonJS 里不合法，写在同步块里会**静默跳过**断言。
 */
async function testPendingAcrossRequests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-pend-"));
  const { UserSpace } = require("./user-store.js");
  const us = new UserSpace({ salt: "pend", singleUser: true, baseDir: tmpDir });
  const store = us.store("local");

  // 请求 1：生成授权链接（实例 A）
  const authA = new AuthManager({ clientId: OFFICIAL_CN_CLIENT_ID, store });
  const au = authA.buildManualAuthorize("shuguang", ["esi-skills.read_skills.v1"], {
    clientId: OFFICIAL_CN_CLIENT_ID,
    redirectUri: OFFICIAL_CN_REDIRECT_URI,
    usePkce: true
  });

  // 请求 2：粘贴回调（实例 B —— 全新实例，模拟独立 HTTP 请求）
  const authB = new AuthManager({ clientId: OFFICIAL_CN_CLIENT_ID, store });
  const p = authB._getPending(au.state);

  ok(!!p, "★ 跨请求能取到 pending 记录");
  ok(p && !!p.verifier, "★ PKCE code_verifier 跨请求存活（长度 " +
    (p && p.verifier ? p.verifier.length : 0) + "）");
  ok(p && p.verifier && p.verifier.length >= 43, "verifier 长度合规");
  ok(p && p.serverKey === "shuguang", "pending 记住了服务器");
  ok(p && p.clientId === OFFICIAL_CN_CLIENT_ID, "pending 记住了 Client ID");
  ok(p && p.redirectUri === OFFICIAL_CN_REDIRECT_URI, "pending 记住了回调地址");
  ok(fs.existsSync(path.join(tmpDir, "local", "pending.json")), "pending 已落盘");

  // 有 pending 但缺 verifier → 本地就该拦下，不发给网易换一个无信息的 500
  const authC = new AuthManager({ clientId: OFFICIAL_CN_CLIENT_ID, store });
  authC._savePending("STATE_NO_VERIFIER", { serverKey: "shuguang", clientId: OFFICIAL_CN_CLIENT_ID });
  let errMsg = "";
  try {
    await (authC.completeManual(
      "https://ali-esi.evepc.163.com/ui/oauth2-redirect.html?code=FAKE&state=STATE_NO_VERIFIER",
      "shuguang"));
  } catch (e) { errMsg = e.message; }
  ok(errMsg.includes("code_verifier"), "★ pending 缺 verifier 时本地就报清楚（不发请求给网易）");
  ok(errMsg.includes("立刻"), "给出了可操作指引（立刻粘贴）");

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
}

/* ---------------- 12. 网易 500 错误的翻译 ---------------- */
section("【网易 500 错误的翻译】");

/**
 * 网易对**任何无效授权码**都返回 HTTP 500 + {"Message":"An error has occurred."}
 * （实测：缺 client_id 才是 401 invalid_client；一旦带上 client_id，
 *   无论 code 是否有效、redirect_uri 是否匹配，都是 500）
 * → 这句话对用户毫无意义，必须翻译成可操作的原因。
 */
async function testNetEase500Translation() {
  const { AuthManager: AM } = require("./auth.js");
  const a = new AM({ clientId: OFFICIAL_CN_CLIENT_ID });
  let msg = "";
  try {
    await (a.completeManual(
      "https://ali-esi.evepc.163.com/ui/oauth2-redirect.html?code=INVALID&state=S",
      "shuguang"));
  } catch (e) { msg = e.message; }

  ok(msg.includes("网易拒绝了这次令牌交换"), "★ 500 被翻译成人话", msg.split("\n")[0].slice(0, 30));
  ok(msg.includes("授权码已过期"), "列出「授权码已过期」这个最常见原因");
  ok(msg.includes("立刻"), "给出可操作指引（立刻粘贴）");
  ok(msg.includes("隐式流程"), "★ 给出了更可靠的备选方案（隐式流程）");
  // 原始英文只作为「网易原话」被引用说明，不应作为错误主体抛给用户
  ok(msg.indexOf("An error has occurred") === -1
    || msg.indexOf("网易拒绝了这次令牌交换") < msg.indexOf("An error has occurred"),
    "★ 不把网易的原始英文当错误主体抛给用户");
}

/* ---------------- 14. 公共 Client ID 的 scope 限制 ---------------- */
section("【公共 Client ID 的 scope 限制】");

/**
 * 实测（2026-11-04，用真实令牌验证）：
 *   网易官方公共 Client ID 签发的令牌，访问**所有需要 scope 的端点**一律 403，
 *   只有公开端点（/characters/{id}）正常。
 *   令牌 payload 里的 scp 字段是**请求值**，不是**授予值**。
 *   → 用公共 ID 授权拿不到技能数据，必须有兜底方案。
 */
async function testOfficialClientLimitation() {
  const { AuthManager: AM, isOfficialClientId: isOff } = require("./auth.js");

  ok(isOff(OFFICIAL_CN_CLIENT_ID), "★ 能识别网易官方公共 Client ID");
  ok(!isOff("my-own-client-id"), "自注册 ID 不误判");

  // 生成授权链接时应带回限制说明
  const a = new AM({ clientId: OFFICIAL_CN_CLIENT_ID });
  const au = a.buildManualAuthorize("shuguang", ["esi-skills.read_skills.v1"], {
    clientId: OFFICIAL_CN_CLIENT_ID,
    redirectUri: OFFICIAL_CN_REDIRECT_URI,
    usePkce: true
  });
  ok(au.usingOfficialClientId === true, "★ 授权链接标记出「用的是公共 Client ID」");
  ok(!!au.limitationNotice, "★ 带回限制说明");
  ok(au.limitationNotice.indexOf("拿不到角色技能") >= 0, "说明里点明拿不到技能");
  ok(au.limitationNotice.indexOf("手动填写") >= 0, "说明里给出手动填写的出路");
  ok(au.url.indexOf("esi-skills.read_skills.v1") >= 0, "仍然申请 skills scope（自建应用时它是关键）");

  // 自注册 ID 不带限制说明
  const b = new AM({ clientId: "my-own-client-id-1234567890" });
  const au2 = b.buildManualAuthorize("shuguang", ["esi-skills.read_skills.v1"], {
    clientId: "my-own-client-id-1234567890",
    redirectUri: "http://localhost:8657/sso/callback",
    usePkce: true
  });
  ok(au2.usingOfficialClientId === false, "自注册 ID 不标记为公共 ID");
  ok(!au2.limitationNotice, "自注册 ID 不带限制说明");
}

/* ---------------- 15. ESI 403 的语义与降级 ---------------- */
section("【ESI 403 的语义与降级】");

async function testEsi403Semantics() {
  const { EsiClient } = require("./esi-client.js");

  // 用一个必然 403 的端点验证错误被标记为 SCOPE_DENIED
  const client = new EsiClient({ server: "shuguang", token: "aaa.bbb.ccc" });
  let code = null, msg = "";
  try {
    await client.request("/characters/12345/skills", null, { auth: true });
  } catch (e) {
    code = e.code;
    msg = e.message;
  }
  ok(code === "SCOPE_DENIED", "★ 403 被标记为 SCOPE_DENIED（区别于 401 令牌失效）", code);
  ok(msg.indexOf("权限不足") >= 0, "错误信息点明是权限问题");
  ok(msg.indexOf("bc90aa49") >= 0, "点明公共 Client ID 的已知限制");
  ok(msg.indexOf("手动填写") >= 0, "给出手动填写的出路");
  ok(msg.indexOf("注册应用") >= 0, "给出自注册应用的出路");

  // 技能不可用时，档案应保留上一次的技能值
  const fs2 = require("fs"), os2 = require("os"), path2 = require("path");
  const tmp = fs2.mkdtempSync(path2.join(os2.tmpdir(), "eve-deg-"));
  const { UserSpace } = require("./user-store.js");
  const { ProfileStore } = require("./profiles.js");
  const us = new UserSpace({ salt: "d", singleUser: true, baseDir: tmp });
  const store = us.store("local");
  const ps = new ProfileStore({
    file: store.profilesFile,
    persist: (p) => store.saveProfiles(p)
  });
  ps.profiles = store.profiles();
  ps.save({ serverKey: "shuguang", characterId: 111, characterName: "A", skills: { ind: 5, acct: 3 } });
  const got = ps.get("shuguang", 111);
  ok(got && got.skills && got.skills.ind === 5, "档案保留已有技能值");
  try { fs2.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
}

/* ---------------- 16. 令牌过期后数据保留 ---------------- */
section("【令牌过期后数据保留】");
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-expire-"));
  const { UserSpace } = require("./user-store.js");
  const { ProfileStore } = require("./profiles.js");
  const us = new UserSpace({ salt: "exp", singleUser: true, baseDir: tmpDir });
  const store = us.store("local");

  // 与 server.js 的 profilesFor 一致的构造方式
  const ps = new ProfileStore({
    file: store.profilesFile,
    persist: (p) => store.saveProfiles(p)
  });
  ps.profiles = store.profiles();
  ps.save({
    serverKey: "shuguang", characterId: 12345, characterName: "测试角色",
    skills: { ind: 5, acct: 3, met: 4 },
    totalSP: 12345, syncedAt: Date.now()
  });

  // 令牌过期（模拟 20 分钟后）
  store.saveTokens({
    "shuguang:12345": {
      serverKey: "shuguang", characterId: 12345,
      accessToken: "EXPIRED", expiresAt: Date.now() - 1000
    }
  });

  // 模拟服务重启后重新加载
  const store2 = us.store("local");
  const ps2 = new ProfileStore({
    file: store2.profilesFile,
    persist: (p) => store2.saveProfiles(p)
  });
  ps2.profiles = store2.profiles();
  const list = ps2.list();

  ok(list.length === 1, "档案在令牌过期 + 重启后仍存在", list.length + " 条");
  ok(list[0] && list[0].skills && Object.keys(list[0].skills).length === 3,
    "★ 技能数据完整保留", JSON.stringify(list[0] && list[0].skills));
  ok(list[0] && list[0].characterName === "测试角色", "角色名保留");

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }
}

/* ------------------------------------------------------------------ */
// ★ 串行执行所有 async 测试段，再统计 ——
//   顶层 await 在 CommonJS 里不合法，写在同步块中会静默跳过断言（假通过）。
testManualChannel()
  .catch(function (e) {
    console.error("  FAIL 手动授权通道抛出异常 → " + (e && e.message ? e.message : e));
    fail++;
  })
  .then(function () {
    return testPendingAcrossRequests();
  })
  .catch(function (e) {
    console.error("  FAIL pending 跨请求验证抛出异常 → " + (e && e.message ? e.message : e));
    fail++;
  })
  .then(function () {
    return testNetEase500Translation();
  })
  .catch(function (e) {
    console.error("  FAIL 网易 500 翻译验证抛出异常 → " + (e && e.message ? e.message : e));
    fail++;
  })
  .then(function () {
    return testOfficialClientLimitation();
  })
  .catch(function (e) {
    console.error("  FAIL 公共 Client ID 限制验证抛出异常 → " + (e && e.message ? e.message : e));
    fail++;
  })
  .then(function () {
    return testEsi403Semantics();
  })
  .catch(function (e) {
    console.error("  FAIL ESI 403 语义验证抛出异常 → " + (e && e.message ? e.message : e));
    fail++;
  })
  .then(function () {
    console.log("\n====================================================");
    console.log("通过 " + pass + " 项，失败 " + fail + " 项");
    console.log("====================================================");
    process.exit(fail === 0 ? 0 : 1);
  });
