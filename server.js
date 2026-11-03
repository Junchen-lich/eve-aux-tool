/*
 * EVE 辅助工具 —— 服务器
 * Copyright (C) 2026 Junchen-lich
 *
 * 职责：
 *   1. 静态托管前端页面与数据表
 *   2. /sso/*   SSO 授权流程（三服双通道）
 *   3. /esi/*   ESI 代理（携带用户令牌，统一错误额度调度）
 *   4. /api/*   业务接口（角色同步、档案管理等）
 *   5. /userdata/* 用户数据读写
 *   6. /healthz 健康检查（负载均衡探活）
 *
 * 零第三方依赖，仅用 Node 内置模块。
 *
 * ★ 部署形态（本地 / 专用服务器 通用）
 *
 *   环境变量：
 *     HOST           监听地址，默认 127.0.0.1（本地）；服务器设为 0.0.0.0
 *                    ※ 默认只绑回环，避免误暴露
 *     PORT           监听端口，默认 8657
 *     BASE_URL       外部访问基址，如 https://eve.example.com
 *                    用于推导 SSO 回调地址；不设则用 http://HOST:PORT
 *     EVE_CLIENT_ID  应用 Client ID
 *     EVE_MULTI_USER 设为 1 启用多用户模式（注册 + 登录 + 数据隔离）
 *                    不设则为单用户模式（本地开发用，不校验口令）
 *     EVE_SALT       服务端盐（不设则自动生成并持久化到 用户数据/server_salt.txt）
 *     TRUST_PROXY    置于反向代理后设为 1，据 X-Forwarded-* 取真实客户端 IP
 *     SESSION_TTL    会话有效期（秒），默认 7 天
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { AuthManager, isOfficialClientId, OFFICIAL_CN_CLIENT_ID, OFFICIAL_CN_REDIRECT_URI } = require("./src/core/auth.js");
const { ProfileStore } = require("./src/core/profiles.js");
const { EsiClient } = require("./src/core/esi-client.js");
const fetcher = require("./src/data/fetcher.js");
const { SERVERS, SERVER_ORDER } = require("./src/core/servers.js");
const {
  UserSpace, signSession, verifySession, parseCookies, LOCAL_USER
} = require("./src/core/user-store.js");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data", "sde");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 8657;
const CLIENT_ID = process.env.EVE_CLIENT_ID || "";
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const MULTI_USER = process.env.EVE_MULTI_USER === "1";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const SESSION_TTL = Number(process.env.SESSION_TTL) || 7 * 24 * 3600 * 1000;

/** 应用版本（读 package.json，缺失则回退） */
const APP_VERSION = (() => {
  try {
    return require(path.join(ROOT, "package.json")).version || "0.0.0";
  } catch (e) { return "0.0.0"; }
})();

/**
 * 代码指纹：源文件的 mtime+size 哈希。
 *
 * ★ 用途：解决「改了代码但接口行为还是旧的」这个反复踩的坑 ——
 *   端口上可能挂着**改动前启动的实例**，健康检查却照样通，
 *   人会以为代码没生效。版本号不够（同一个版本内也在改），
 *   所以这里给每个实例算一个指纹，客户端可据此判断实例是否过期。
 */
const CODE_FINGERPRINT = (() => {
  try {
    const files = [
      "server.js",
      path.join("src", "core", "auth.js"),
      path.join("src", "core", "servers.js"),
      path.join("src", "core", "profiles.js"),
      path.join("src", "core", "esi-client.js"),
      path.join("src", "core", "user-store.js"),
      path.join("src", "ui", "app.js"),
      path.join("src", "ui", "calc-core.js")
    ];
    const crypto = require("crypto");
    const h = crypto.createHash("sha256");
    for (const f of files) {
      const p = path.join(ROOT, f);
      try {
        const st = fs.statSync(p);
        h.update(f + ":" + st.size + ":" + Math.floor(st.mtimeMs) + ";");
      } catch (e) { h.update(f + ":missing;"); }
    }
    return h.digest("hex").slice(0, 12);
  } catch (e) { return "unknown"; }
})();

/**
 * 回调地址：BASE_URL 优先，否则由监听地址推导。
 *
 * ★ 必须跟随**实际监听端口**：端口被占用时 server.js 会自动 +1 顺延，
 *   若这里在启动时按 PORT 固化，回调就会指向一个没人监听的端口，
 *   网易在登录后校验时判定「redirect URL 不匹配」而授权失败。
 *   因此这里用函数而非常量，在每次发起授权时按当前端口重新计算。
 *
 * ★ 主机名统一用 localhost（而非 127.0.0.1）：
 *   网易把 redirect_uri 当**字符串**比对，localhost 与 127.0.0.1 是两个
 *   不同值。后台登记的是哪个就得用哪个，否则同样报「不匹配」。
 *   这里固定输出 localhost，因为它是开发者后台最常用的登记形式。
 */
function defaultRedirectUri(port) {
  if (BASE_URL) return BASE_URL + "/sso/callback";
  return "http://localhost:" + (port || PORT) + "/sso/callback";
}

/**
 * 取指定服务器的回调地址。优先级：
 *   1. 用户在「设置」页按服填写的 redirectUriByServer[serverKey]
 *   2. 环境变量 EVE_REDIRECT_URI（服务器部署场景统一入口）
 *   3. 按实际监听端口推导（本地开发）
 */
function redirectUriFor(user, serverKey) {
  // 1) 用户按服填写的回调地址（设置页「各服回调地址」）
  try {
    const meta = user && user.store ? user.store.meta() : null;
    const perServer = meta && meta.servers && meta.servers[serverKey];
    if (perServer && perServer.redirectUri) return perServer.redirectUri;
  } catch (e) { /* 读不到配置则继续 */ }

  // 2) 旧版全局配置（设置页早期版本 / 旧配置文件）
  const legacy = (user && user.store && user.store.meta() && user.store.meta().redirectUri)
    || cfg.redirectUri || "";
  if (legacy) {
    // ★ 端口与实际监听端口不一致时**不能盲信**：
    //   陈旧的回调地址正是「redirect URL 不匹配」的常见成因之一。
    const m = String(legacy).match(/^https?:\/\/[^:/]+:(\d+)/);
    const port = m ? Number(m[1]) : null;
    if (!port || port === currentPort) return legacy;
    // 端口已变 → 按实际端口重建，保留原主机名与路径
    return legacy.replace(/^https?:\/\/[^:/]+:\d+/, "http://localhost:" + currentPort);
  }

  // 3) 环境变量（服务器部署场景统一入口）
  if (process.env.EVE_REDIRECT_URI) return process.env.EVE_REDIRECT_URI;

  // 4) 按实际监听端口推导
  return defaultRedirectUri(currentPort);
}

/* 应用配置存用户数据目录，便于用户改 */
const CONFIG_FILE = path.join(ROOT, "用户数据", "eve_config_v1.json");

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) { return {}; }
}

const cfg = loadConfig();

/* ★ 用户空间：多用户隔离的核心 */
const userSpace = new UserSpace({
  salt: process.env.EVE_SALT || "",
  singleUser: process.env.EVE_MULTI_USER !== "1"   // 默认单用户；服务器部署设 EVE_MULTI_USER=1
});
userSpace.migrateLegacy();

/* ---------- 令牌落盘加密密钥 ---------- */
/* 多用户模式启用：由服务端盐派生 AES-256 密钥，磁盘上不存明文 EVE 令牌 */
const ENCRYPTION_KEY = (() => {
  if (!MULTI_USER) return null;
  try {
    const { deriveKey } = require("./src/core/auth.js");
    return deriveKey(userSpace.salt);
  } catch (e) {
    console.error("令牌加密初始化失败：" + e.message);
    return null;
  }
})();

/**
 * 取当前请求的用户上下文。
 * 单用户模式 → 固定 local 用户；
 * 多用户模式 → 校验会话 Cookie，无效则返回 null（需登录）。
 */
function currentUser(req) {
  if (userSpace.singleUser) {
    return { userId: LOCAL_USER, store: userSpace.store(LOCAL_USER) };
  }
  const cookies = parseCookies(req.headers.cookie);
  const uid = verifySession(cookies.eve_session, userSpace.salt);
  if (!uid) return null;
  return { userId: uid, store: userSpace.store(uid) };
}

/**
 * 网易官方公共 ESI 应用的 Client ID 与回调地址。
 *
 * ★ 这个 ID 是网易自己注册给 ESI 官网用的，
 *   它在后台登记的回调地址固定为
 *   https://ali-esi.evepc.163.com/ui/oauth2-redirect.html
 *   —— 用它做「自动跳回本地」的标准流程必然被判定
 *   「The redirect URL does not match any of the configured values for this client」。
 *
 *   可行用法是**手动授权通道**（见 apiManualAuthLink / apiManualAuth）：
 *   在浏览器里用官方落地页完成授权，再把地址栏的回调 URL 粘回工具。
 *
 *   ★ 实测（2026-11-03）：不带 ali- 前缀的 esi.evepc.163.com 稳定返回 503，
 *     只有 ali-esi.evepc.163.com 返回 200 —— 第三方教程里流传的旧地址已失效。
 *
 * 常量统一从 src/core/auth.js 引入，此处不再重复定义。
 */

/**
 * 按服务器解析应用凭据。
 *
 * ★ 三套集群各自独立注册应用，Client ID 不能混用：
 *   · 欧服（宁静）  → CCP 开发者后台 developers.eveonline.com 注册
 *   · 国服（晨曦）  → 网易开发者后台注册
 *   · 国服（曙光）  → 曙光是独立集群（独立账号与角色），通常需**单独注册**，
 *                     其登记的回调地址与晨曦互不相通
 *   用错 Client ID 会得到网易的
 *   「The redirect URL does not match any of the configured values for this client」。
 *
 * 优先级：用户「设置」页按服配置 → 环境变量 → 全局兜底。
 */
function credentialsFor(user, serverKey) {
  const meta = (user && user.store) ? user.store.meta() : {};
  const isCN = serverKey === "serenity" || serverKey === "shuguang";

  // 1) 用户按服配置（设置页填写）
  const perServer = meta.servers && meta.servers[serverKey];
  if (perServer && perServer.clientId) {
    return {
      clientId: perServer.clientId,
      clientSecret: perServer.clientSecret || "",
      redirectUri: perServer.redirectUri || redirectUriFor(user, serverKey)
    };
  }

  // 2) 环境变量：国服可区分晨曦/曙光，欧服用通用
  const envClientId = isCN
    ? (serverKey === "shuguang"
      ? (process.env.EVE_CLIENT_ID_SG || process.env.EVE_CLIENT_ID_CN)
      : (process.env.EVE_CLIENT_ID_CN || process.env.EVE_CLIENT_ID))
    : (process.env.EVE_CLIENT_ID || process.env.EVE_CLIENT_ID_CN);
  if (envClientId) {
    return {
      clientId: envClientId,
      clientSecret: isCN
        ? (process.env.EVE_CLIENT_SECRET_CN || "")
        : (process.env.EVE_CLIENT_SECRET || ""),
      redirectUri: redirectUriFor(user, serverKey)
    };
  }

  // 3) 全局兜底（设置页旧格式）
  const globalId = meta.clientId || cfg.clientId || CLIENT_ID;
  return {
    clientId: globalId,
    clientSecret: meta.clientSecret || cfg.clientSecret || "",
    redirectUri: redirectUriFor(user, serverKey)
  };
}

/* 按用户隔离的鉴权与档案存取 */
function authFor(user, serverKey) {
  const cred = credentialsFor(user, serverKey);
  const auth = new AuthManager({
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    redirectUri: cred.redirectUri,
    // 服务器部署时用盐派生密钥，令牌落盘加密
    encryptionKey: ENCRYPTION_KEY,
    store: user.store
  });
  // 记录本次授权所用的服务器，便于刷新令牌时沿用同一套凭据
  auth.serverKey = serverKey;
  return auth;
}

function persistAuth(user, auth) {
  if (user.store) { try { auth._save(); } catch (e) { } }
}

function profilesFor(user) {
  // ★ 档案必须按用户隔离：ProfileStore 默认读全局文件，
  //   多用户模式下会让所有人共用一份角色档案 —— 显式传入该用户自己的路径，
  //   并把持久化出口指向该用户的存储。
  const ps = new ProfileStore({
    file: user.store.profilesFile,
    persist: function (profiles) { user.store.saveProfiles(profiles); }
  });
  ps.profiles = user.store.profiles();
  return ps;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
function sendJSON(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function sendHTML(res, html, status) {
  res.writeHead(status || 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(html);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => {
      body += c;
      if (body.length > (limit || 1024 * 1024)) { reject(new Error("请求体过大")); req.destroy(); }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveFile(res, file, contentType) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("未找到");
    }
    // ★ 用 no-store 而非 no-cache：
    //   no-cache 允许浏览器存副本，只要求「使用前重新验证」；
    //   但本服务不提供 ETag / Last-Modified，浏览器拿不到可验证的信息，
    //   实践中会直接用旧副本 —— 改前端后页面仍是旧版（本次踩过）。
    //   本地开发工具宁可多一次请求，也不给用户看陈旧界面。
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store, must-revalidate"
    });
    res.end(data);
  });
}

/** 读取 URL 查询参数 */
function queryOf(url) {
  const i = url.indexOf("?");
  const q = {};
  if (i < 0) return q;
  for (const [k, v] of new URLSearchParams(url.slice(i + 1))) q[k] = v;
  return q;
}

/* ------------------------------------------------------------------ *
 * SSO 流程
 * ------------------------------------------------------------------ */

/**
 * GET /sso/start?server=serenity&scope=a,b
 *   欧服：302 跳转到 login.eveonline.com
 *   国服：POST 转发到国服登录页（配置 ssoAuthorizeMethod 决定）
 */
/**
 * ★ 授权前预检：拦下必然失败的请求。
 *
 * 网易在**登录之后**才校验 redirect_uri，所以带着错误回调地址跳过去，
 * 用户要完整登录一遍才看到一句「redirect URL does not match」——
 * 体验极差。这里在跳转前就检查，能省掉一整轮登录。
 *
 * 检查项：
 *   1) 用了网易官方公共 Client ID，但回调地址不是官方落地页 → 必然失败
 *   2) 回调地址指向的端口与本服务实际监听端口不一致 → 必然失败
 */
function precheckAuth(user, serverKey, auth) {
  const warnings = [];
  const redirectUri = auth.redirectUri;

  // 1) 官方公共 Client ID 的回调地址限定
  if (isOfficialClientId(auth.clientId)
      && String(redirectUri || "").trim() !== OFFICIAL_CN_REDIRECT_URI) {
    warnings.push(
      "你正在用网易官方公共 Client ID（" + OFFICIAL_CN_CLIENT_ID + "）授权「" +
      SERVERS[serverKey].label + "」。\n" +
      "该 ID 在网易后台只登记了回调地址 " + OFFICIAL_CN_REDIRECT_URI + "，\n" +
      "而本工具本次上报的是 " + redirectUri + "。\n" +
      "网易会在你登录之后才校验回调地址，届时会报：\n" +
      "  The redirect URL does not match any of the configured values for this client.\n" +
      "\n" +
      "解决：在「设置」页为该服填入你自己在网易开发者后台注册的 Client ID，\n" +
      "      并把回调地址登记为 " + redirectUri + "。\n" +
      "      （曙光服是独立集群，需在网易后台单独注册，不能与晨曦共用。）");
  }

  // 2) 回调端口与实际监听端口是否一致
  if (!process.env.EVE_REDIRECT_URI && !BASE_URL) {
    const m = String(redirectUri || "").match(/^https?:\/\/[^:/]+:(\d+)/);
    const port = m ? Number(m[1]) : null;
    if (port && port !== currentPort) {
      warnings.push(
        "回调地址的端口（" + port + "）与本服务实际监听端口（" + currentPort + "）不一致，\n" +
        "授权后回调将无人接收。请在「设置」页把回调地址改为 " +
        defaultRedirectUri(currentPort) + "。");
    }
  }

  return warnings;
}

/**
 * GET /sso/start?server=serenity&scope=a,b
 *   欧服：302 跳转到 login.eveonline.com
 *   国服：POST 转发到国服登录页（配置 ssoAuthorizeMethod 决定）
 */
async function ssoStart(req, res, url, q, user) {
  const serverKey = q.server || "serenity";
  const scopes = (q.scope || "esi-skills.read_skills.v1").split(",").map(s => s.trim()).filter(Boolean);
  try {
    // ★ 传入 serverKey：按服解析 Client ID 与回调地址
    const auth = authFor(user, serverKey);

    // ★ 预检：拦下必然失败的授权，避免用户白登录一次
    const warnings = precheckAuth(user, serverKey, auth);
    if (warnings.length) {
      return sendHTML(res, `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>授权前置检查未通过</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;max-width:760px;margin:0 auto;line-height:1.7">
<h2 style="color:#c0392b">授权前置检查未通过</h2>
${warnings.map(w => "<pre style=\"white-space:pre-wrap;background:#fdf3f2;padding:16px;border-radius:8px;border-left:4px solid #c0392b\">" + escapeHtml(w) + "</pre>").join("\n")}
<p><a href="/">返回工具</a>（到「设置」页调整后再试）</p>
</body></html>`, 400);
    }

    const au = auth.buildAuthorize(serverKey, scopes);
    // ★ 授权状态由 AuthManager._savePending 落盘（按用户隔离，多用户同时授权
    //   时 state 不会互相覆盖）。这里补齐该服凭据，供回调时还原。
    user.store.savePending && user.store.savePending(au.state, {
      verifier: au.form ? au.form.code_verifier : null,
      serverKey,
      clientId: auth.clientId,
      redirectUri: auth.redirectUri
    });
    if (au.method === "GET") {
      res.writeHead(302, { "Location": au.url });
      return res.end();
    }
    // 国服：转发页 —— 用表单 POST 到国服登录页
    const fields = Object.entries(au.form)
      .map(([k, v]) => `<input type="hidden" name="${escapeAttr(k)}" value="${escapeAttr(v)}">`)
      .join("\n");
    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>正在前往 EVE 登录…</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center">
<form id="f" method="POST" action="${escapeAttr(SERVERS[serverKey].ssoAuthorize)}">
${fields}
<noscript><button type="submit">继续</button></noscript>
</form>
<p>正在前往 EVE 登录页面…若未自动跳转，请点<a href="#" onclick="document.getElementById('f').submit();return false;">这里继续</a>。</p>
<script>document.getElementById('f').submit();</script>
</body></html>`;
    sendHTML(res, html);
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 400);
  }
}

/**
 * GET /sso/callback?code=...&state=...
 */
async function ssoCallback(req, res, url, q, user) {
  const code = q.code;
  const state = q.state;
  if (!code) {
    return sendHTML(res, `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>授权失败</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">
<h2>授权失败</h2><p>未收到授权码。</p><p><a href="/">返回工具</a></p></body></html>`, 400);
  }
  try {
    // 回调时按 state 记录的服务器取凭据（不能用查询参数，state 才可信）
    const pending = user.store.pending ? user.store.pending(state) : null;
    const serverKey = (pending && pending.serverKey) || q.server || "serenity";
    const auth = authFor(user, serverKey);
    const rec = await auth.exchangeCode(code, state, serverKey);
    user.store.clearPending && user.store.clearPending(state);
    persistAuth(user, auth);
    // 通知前端（若页面开着）
    sendHTML(res, `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>授权成功</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px;text-align:center">
<h2>授权成功</h2>
<p>角色：<strong>${escapeHtml(rec.characterName || rec.characterId)}</strong></p>
<p>服务器：${escapeHtml(SERVERS[rec.serverKey] ? SERVERS[rec.serverKey].label : rec.serverKey)}</p>
<p>正在同步角色数据…</p>
<p><a href="/">返回工具</a></p>
<script>
fetch('/api/sync', {method:'POST',headers:{'Content-Type':'application/json'},
  body: JSON.stringify({serverKey:${JSON.stringify(rec.serverKey)}, characterId:${rec.characterId}})})
  .then(function(){ location.href='/'; });
</script>
</body></html>`);
  } catch (e) {
    sendHTML(res, `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>授权失败</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">
<h2>授权失败</h2><p>${escapeHtml(e.message)}</p><p><a href="/">返回工具</a></p></body></html>`, 400);
  }
}

/* ------------------------------------------------------------------ *
 * 业务接口
 * ------------------------------------------------------------------ */

/** GET /api/config —— 前端初始化用 */
function apiConfig(req, res, user) {
  // 分服凭据状态：前端「设置」页据此显示每个服是否已配置
  const servers = SERVER_ORDER.map(k => {
    const cred = credentialsFor(user, k);
    const meta = (user && user.store) ? user.store.meta() : {};
    const perServer = meta.servers && meta.servers[k];
    return {
      key: k,
      label: SERVERS[k].label,
      short: SERVERS[k].short,
      esiBase: SERVERS[k].esiBase,
      authorizeMethod: SERVERS[k].ssoAuthorizeMethod,
      // 该服是否已配置可用 Client ID
      clientIdConfigured: !!cred.clientId,
      // 该服当前生效的回调地址
      redirectUri: cred.redirectUri,
      // 是否使用网易官方公共 Client ID（回调地址被限定，只能用官方落地页）
      usingOfficialClientId: isOfficialClientId(cred.clientId),
      // ★ 回显已保存的 Client ID（便于用户核对）；secret 只回传「是否已设置」
      clientId: cred.clientId || "",
      clientSecretSet: !!(perServer && perServer.clientSecret) || !!cred.clientSecret,
      // 标记该服是否用了「按服独立配置」（而非全局兜底）
      perServerConfigured: !!(perServer && perServer.clientId)
    };
  });

  sendJSON(res, {
    ok: true,
    clientIdConfigured: servers.some(s => s.clientIdConfigured),
    redirectUri: defaultRedirectUri(currentPort),
    baseUrl: BASE_URL || null,
    multiUser: MULTI_USER,
    servers
  });
}

/** POST /api/sync —— 同步角色数据 */
async function apiSync(req, res, user, auth, profiles) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJSON(res, { ok: false, error: "请求体不是有效 JSON" }, 400); }

  const serverKey = body.serverKey;
  const characterId = Number(body.characterId);
  const key = ProfileStore.key(serverKey, characterId);
  const tokenRec = auth.tokens[key];
  if (!tokenRec) return sendJSON(res, { ok: false, error: "该角色未授权，请先授权" }, 401);

  try {
    const accessToken = await auth.getValidToken(key);
    const profile = await profiles.sync({
      serverKey,
      characterId,
      accessToken,
      onStatus: (s) => { /* 可接入 SSE 暂略 */ }
    });
    persistAuth(user, auth);
    sendJSON(res, {
      ok: true,
      characterName: profile.characterName,
      skills: profile.skills,
      skillChanges: profile.skillChanges || [],
      unmatched: profile.unmatchedSkills || [],
      totalSP: profile.totalSP,
      wallet: profile.wallet,
      assets: profile.assets,
      industryJobs: profile.industryJobs,
      // ★ 技能是否取不到（scope 未授予）——界面据此给出出路提示
      skillsUnavailable: !!profile.skillsUnavailable,
      skillsUnavailableReason: profile.skillsUnavailableReason || null,
      skillsErrorMessage: profile.skillsErrorMessage || null
    });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * POST /api/skills/manual
 *   body: { serverKey, characterId, characterName, skills: { skillId: level } }
 *
 * ★ 手动填写技能等级 —— 当官方公共 Client ID 拿不到技能时的兜底路径。
 *   数据落到与自动同步同一份角色档案里，同样长期保留在本地。
 */
async function apiSkillsManual(req, res, user, profiles) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJSON(res, { ok: false, error: "请求体不是有效 JSON" }, 400); }

  const serverKey = body.serverKey || "serenity";
  if (!SERVERS[serverKey]) return sendJSON(res, { ok: false, error: "未知服务器" }, 400);
  const characterId = Number(body.characterId);
  if (!characterId) return sendJSON(res, { ok: false, error: "缺少角色 ID" }, 400);

  const raw = body.skills || {};
  const skills = {};
  for (const [k, v] of Object.entries(raw)) {
    const lv = Math.max(0, Math.min(5, parseInt(v, 10) || 0));
    if (lv > 0) skills[k] = lv;
  }
  if (!Object.keys(skills).length) {
    return sendJSON(res, { ok: false, error: "至少要填一项技能" }, 400);
  }

  try {
    const ps = profilesFor(user);
    const prev = ps.get(serverKey, characterId);
    const profile = ps.save({
      serverKey,
      characterId,
      characterName: body.characterName || (prev && prev.characterName) || ("角色 " + characterId),
      skills,
      skillSnapshot: (prev && prev.skills) || Object.assign({}, skills),
      // ★ 标记为手动填写 —— 界面要提示「这些数值是手填的，不会自动更新」
      manualSkills: true,
      totalSP: (prev && prev.totalSP) || 0,
      syncedAt: Date.now()
    });
    sendJSON(res, {
      ok: true,
      characterId: profile.characterId,
      characterName: profile.characterName,
      skillCount: Object.keys(profile.skills || {}).length,
      skills: profile.skills
    });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * GET /api/profiles —— 角色档案列表（前台中文展示） */
function apiProfiles(req, res, profiles) {
  sendJSON(res, { ok: true, profiles: profiles.list() });
}

/* ------------------------------------------------------------------ *
 * 手动授权通道（网易官方公共 Client ID）
 *
 * ★ 场景：网易官方公共 Client ID 只登记了官方落地页作为回调地址，
 *   本地工具无法自动跳回，只能让用户在浏览器完成授权后
 *   把地址栏的回调 URL 粘回来，由工具拿 code 换令牌。
 *   —— 与 raoganzi.com 的做法一致。
 * ------------------------------------------------------------------ */

/**
 * GET /api/auth/manual?server=shuguang&scope=a,b&mode=code
 *   生成授权链接（mode=code 授权码流程 / mode=token 隐式流程）
 */
function apiManualAuthLink(req, res, user, q) {
  const serverKey = q.server || "serenity";
  if (!SERVERS[serverKey]) return sendJSON(res, { ok: false, error: "未知服务器" }, 400);
  const scopes = (q.scope || "esi-skills.read_skills.v1").split(",").map(s => s.trim()).filter(Boolean);
  const mode = q.mode === "token" ? "token" : "code";

  try {
    const auth = authFor(user, serverKey);
    const info = auth.buildManualAuthorize(serverKey, scopes, {
      clientId: auth.clientId,
      redirectUri: OFFICIAL_CN_REDIRECT_URI,
      usePkce: mode === "code"
    });
    sendJSON(res, {
      ok: true,
      url: info.url,
      state: info.state,
      mode: info.mode,
      serverKey,
      serverLabel: SERVERS[serverKey].label,
      // ★ 公共 Client ID 的能力限制（实测：该 ID 拿不到技能数据）
      usingOfficialClientId: !!info.usingOfficialClientId,
      limitationNotice: info.limitationNotice || null,
      // 提示用户接下来该做什么
      hint: mode === "token"
        ? "在浏览器打开上面的链接并登录授权，授权后浏览器地址栏会出现 #access_token=… 的地址，" +
          "把它整段复制粘贴回工具即可。"
        : "在浏览器打开上面的链接并登录授权，授权后浏览器地址栏会出现带 ?code=… 的地址，" +
          "把它整段复制粘贴回工具即可。"
    });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 400);
  }
}

/**
 * POST /api/auth/manual
 *   body: { serverKey, pasted }
 *   pasted = 用户从浏览器地址栏复制回来的回调 URL 或 token 片段
 */
async function apiManualAuth(req, res, user) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJSON(res, { ok: false, error: "请求体不是有效 JSON" }, 400); }

  const serverKey = body.serverKey || "serenity";
  if (!SERVERS[serverKey]) return sendJSON(res, { ok: false, error: "未知服务器" }, 400);
  const pasted = String(body.pasted || "").trim();
  if (!pasted) return sendJSON(res, { ok: false, error: "请粘贴授权后的回调地址" }, 400);

  try {
    const auth = authFor(user, serverKey);
    const out = await auth.completeManual(pasted, serverKey);
    persistAuth(user, auth);

    // ★ 令牌拿到后立刻同步一次角色数据 —— 数据落到档案后长期保留，
    //   与令牌是否过期无关。
    //   注意：技能可能因 scope 未授予而取不到（网易公共 Client ID 的已知限制），
    //   这时**不算失败** —— 角色公开信息仍然可用，要如实告诉用户缺什么。
    let syncNote = null;
    try {
      const profiles = profilesFor(user);
      const profile = await profiles.sync({
        serverKey: out.rec.serverKey,
        characterId: out.rec.characterId,
        accessToken: out.rec.accessToken
      });
      syncNote = {
        characterName: profile.characterName,
        characterId: profile.characterId,
        skillCount: Object.keys(profile.skills || {}).length,
        skillsUnavailable: !!profile.skillsUnavailable,
        skillsUnavailableReason: profile.skillsUnavailableReason || null,
        skillsErrorMessage: profile.skillsErrorMessage || null
      };
    } catch (e) {
      syncNote = { error: "令牌已取得，但同步角色数据失败：" + e.message };
    }

    sendJSON(res, {
      ok: true,
      characterId: out.rec.characterId,
      characterName: out.rec.characterName,
      serverKey: out.rec.serverKey,
      expiresAt: out.rec.expiresAt,
      hasRefresh: !!out.rec.refreshToken,
      source: out.rec.source,
      warning: out.warning,
      sync: syncNote,
      // ★ 令牌成功但技能没拿到 —— 不算失败，但要明确告知
      skillsUnavailable: !!(syncNote && syncNote.skillsUnavailable),
      skillsUnavailableReason: (syncNote && syncNote.skillsUnavailableReason) || null,
      guidance: (syncNote && syncNote.skillsUnavailable)
        ? ("授权成功，角色身份已识别，但**技能数据拿不到**。\n" +
           "原因：网易官方公共 Client ID 在后台没有授予 esi-skills.read_skills.v1，\n" +
           "其令牌访问技能/属性/钱包等接口一律返回 403。\n" +
           "\n" +
           "接下来三选一：\n" +
           "1) **自己注册应用**（推荐，一劳永逸）\n" +
           "   在网易开发者后台为该服注册应用，勾选「读取角色技能」，\n" +
           "   把 Client ID 填进「设置」页，再走标准授权流程。\n" +
           "2) **手动填写技能等级**\n" +
           "   在「角色」页点「手动填写技能」，把 14 项技能等级填进去，\n" +
           "   数据同样长期保留，核算功能完全可用。\n" +
           "3) 暂时不管 —— 工具会按 0 级技能计算税率（偏保守）。")
        : null
    });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 400);
  }
}

/** DELETE /api/profiles?key=... —— 删除档案 */
function apiProfileDelete(req, res, url, q, profiles) {
  const key = q.key;
  if (!key) return sendJSON(res, { ok: false, error: "缺少 key" }, 400);
  const p = profiles.remove(key);
  sendJSON(res, { ok: true, removed: p });
}

/** POST /api/config —— 保存 Client ID 等配置（按用户隔离） */
async function apiConfigSave(req, res, user) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJSON(res, { ok: false, error: "请求体不是有效 JSON" }, 400); }
  try {
    // 用户的 Client ID 存在自己的目录里（多用户各自独立）
    const meta = user.store.meta();
    if (body.clientId !== undefined) meta.clientId = body.clientId;
    if (body.clientSecret !== undefined) meta.clientSecret = body.clientSecret;
    if (body.redirectUri) meta.redirectUri = body.redirectUri;

    // ★ 分服凭据：三套集群的 Client ID 互不通用，各自独立保存
    if (body.servers && typeof body.servers === "object") {
      if (!meta.servers || typeof meta.servers !== "object") meta.servers = {};
      for (const key of Object.keys(body.servers)) {
        if (!SERVERS[key]) continue;              // 只接受已知服务器键
        const incoming = body.servers[key] || {};
        const cur = meta.servers[key] || {};
        if (incoming.clientId !== undefined) cur.clientId = String(incoming.clientId || "").trim();
        if (incoming.clientSecret !== undefined) cur.clientSecret = String(incoming.clientSecret || "").trim();
        if (incoming.redirectUri !== undefined) cur.redirectUri = String(incoming.redirectUri || "").trim();
        meta.servers[key] = cur;
      }
    }

    user.store._writeJson(user.store.metaFile, meta);
    sendJSON(res, { ok: true });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/* ------------------------------------------------------------------ *
 * 登录 / 登出（多用户模式）
 * ------------------------------------------------------------------ */

/** 登录页 */
function loginPage(msg, mode) {
  const err = msg ? `<p style="color:#e05a5a;margin:0 0 16px">${escapeHtml(msg)}</p>` : "";
  const isRegister = mode === "register";
  const action = isRegister ? "/api/register" : "/api/login";
  const btn = isRegister ? "注册并登录" : "登录";
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${isRegister ? "注册" : "登录"} · EVE 辅助工具</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#12161c;color:#e6e9ef;
     display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#1a2029;border:1px solid #2a3441;border-radius:12px;padding:36px 32px;width:330px}
h1{font-size:18px;margin:0 0 6px;font-weight:600}
p.sub{color:#8b97a8;font-size:13px;margin:0 0 24px}
label{display:block;font-size:13px;color:#a8b3c4;margin:0 0 6px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:7px;
     border:1px solid #2f3a48;background:#12161c;color:#e6e9ef;font-size:14px;margin-bottom:16px}
button{width:100%;padding:10px;border:0;border-radius:7px;background:#4a9eff;color:#fff;
     font-size:14px;font-weight:600;cursor:pointer}
button:hover{background:#3b8ce8}
button.ghost{background:transparent;border:1px solid #2f3a48;color:#8b97a8;margin-top:10px}
button.ghost:hover{background:#202834;color:#c8d2e0}
.hint{color:#6b7686;font-size:12px;margin-top:18px;line-height:1.6}
</style></head><body>
<div class="box">
<h1>EVE 辅助工具</h1>
<p class="sub">${isRegister ? "创建账号以保存你的角色数据" : "请登录以继续"}</p>
${err}
<form method="POST" action="${action}">
<label for="un">用户名</label>
<input id="un" name="username" type="text" autofocus autocomplete="username" required>
<label for="pw">${isRegister ? "口令（至少 6 位）" : "口令"}</label>
<input id="pw" name="password" type="password" autocomplete="${isRegister ? "new-password" : "current-password"}" required>
<button type="submit">${btn}</button>
</form>
<form method="POST" action="${isRegister ? "/api/login" : "/api/register"}">
<button class="ghost" type="submit">${isRegister ? "已有账号？去登录" : "没有账号？去注册"}</button>
</form>
<div class="hint">每个账号对应独立的角色数据空间，互不可见。<br>你的 EVE 授权令牌仅保存在自己的空间内。</div>
</div></body></html>`;
}

/**
 * POST /api/login  （用户名 + 口令）
 * GET  /api/login?username=..&password=..（供脚本调用）
 */
async function apiLogin(req, res, q) {
  if (!MULTI_USER) {
    return sendJSON(res, { ok: true, mode: "single-user", message: "单用户模式，无需登录" });
  }
  const body = await readBody(req);
  const username = q.username || extractForm(body, "username");
  const password = q.password || extractForm(body, "password");
  if (!username || !password) {
    return sendHTML(res, loginPage("请填写用户名与口令"), 400);
  }
  const r = userSpace.authenticate(username, password);
  if (!r.ok) {
    return sendHTML(res, loginPage(r.error), 401);
  }
  grantSession(res, r.userId);
}

/** POST /api/register */
async function apiRegister(req, res, q) {
  if (!MULTI_USER) {
    return sendJSON(res, { ok: true, mode: "single-user" });
  }
  // ★ 注册频率限制：单 IP 每小时最多 5 个账号
  //   Nginx 只能限「请求频率」，这里限「注册数量」——批量刷目录的真正防线
  const ip = clientIp(req);
  const now = Date.now();
  const hourAgo = now - 3600 * 1000;
  regLog[ip] = (regLog[ip] || []).filter(t => t > hourAgo);
  if (regLog[ip].length >= MAX_REG_PER_HOUR) {
    return sendHTML(res, loginPage(
      "注册过于频繁（每小时最多 " + MAX_REG_PER_HOUR + " 个账号），请稍后再试", "register"), 429);
  }

  const body = await readBody(req);
  const username = q.username || extractForm(body, "username");
  const password = q.password || extractForm(body, "password");
  if (!username || !password) {
    return sendHTML(res, loginPage("请填写用户名与口令", "register"), 400);
  }
  const r = userSpace.register(username, password);
  if (!r.ok) {
    return sendHTML(res, loginPage(r.error, "register"), 400);
  }
  regLog[ip].push(now);
  grantSession(res, r.userId);
}

/** 签发会话 Cookie 并跳转首页 */
function grantSession(res, userId) {
  const exp = Date.now() + SESSION_TTL;
  const cookie = signSession(userId, exp, userSpace.salt);
  res.writeHead(302, {
    "Set-Cookie": "eve_session=" + encodeURIComponent(cookie) +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.floor(SESSION_TTL / 1000),
    "Location": "/"
  });
  res.end();
}

/** POST /api/logout */
function apiLogout(req, res) {
  res.writeHead(302, {
    "Set-Cookie": "eve_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    "Location": "/"
  });
  res.end();
}

/** 从请求体（表单或 JSON）取字段 */
function extractForm(raw, field) {
  if (!raw) return null;
  const s = String(raw);
  if (s.trim().startsWith("{")) {
    try { return JSON.parse(s)[field] || null; } catch (e) { return null; }
  }
  return new URLSearchParams(s).get(field);
}

/* ---------- 注册频率限制 ---------- */
/* 按 IP 记录注册时间戳，超过阈值即拒绝。定期清理，防止内存增长。 */
const MAX_REG_PER_HOUR = Number(process.env.EVE_MAX_REG_PER_HOUR) || 5;
const regLog = Object.create(null);
setInterval(() => {
  const hourAgo = Date.now() - 3600 * 1000;
  for (const ip of Object.keys(regLog)) {
    regLog[ip] = regLog[ip].filter(t => t > hourAgo);
    if (!regLog[ip].length) delete regLog[ip];
  }
}, 10 * 60 * 1000).unref();

/**
 * /esi/* —— ESI 代理
 *   前端请求 /esi/serenity/status/ → 转发到该服 ESI
 *   可选头 X-Eve-Token-Key 指定用哪个已保存的令牌
 */
async function esiProxy(req, res, url, user) {
  const m = url.match(/^\/esi\/([a-z]+)\/(.*)$/);
  if (!m) return sendJSON(res, { ok: false, error: "路径格式应为 /esi/{server}/{path}" }, 400);
  const [, serverKey, rest] = m;
  if (!SERVERS[serverKey]) return sendJSON(res, { ok: false, error: "未知服务器" }, 400);

  // ★ 按目标服务器取凭据：换令牌/刷新令牌要用该服自己的 Client ID，
  //   用错服的 Client ID 会得到「invalid_client」或回调地址不匹配。
  const auth = authFor(user, serverKey);
  const cfgS = SERVERS[serverKey];
  // ★ 注意：esiBase 已含 "/latest" 前缀，不能用 new URL(rest, base)（会覆盖路径）
  //   故手工拼接：base + "/" + rest
  const qi0 = url.indexOf("?");
  const restPath = qi0 >= 0 ? url.slice("/esi/".length + serverKey.length + 1, qi0)
                             : url.slice("/esi/".length + serverKey.length + 1);
  const qs = qi0 >= 0 ? url.slice(qi0) : "";
  const target = cfgS.esiBase.replace(/\/+$/, "") + "/" + restPath.replace(/^\/+/, "") + qs;

  const headers = { "User-Agent": "EVE-AuxTool/0.1", "Accept": "application/json" };
  // 令牌
  const tokenKey = req.headers["x-eve-token-key"];
  if (tokenKey && auth.tokens[tokenKey]) {
    try { headers.Authorization = "Bearer " + (await auth.getValidToken(tokenKey)); }
    catch (e) { /* 令牌失效则按未授权请求 */ }
  }

  try {
    const upstream = await fetch(target.toString(), { headers, signal: AbortSignal.timeout(60000) });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    res.end(text);
  } catch (e) {
    sendJSON(res, { ok: false, error: "上游请求失败：" + e.message }, 502);
  }
}

/* ------------------------------------------------------------------ *
 * 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = req.url || "/";
  const q = queryOf(url);
  const started = Date.now();

  // 访问日志（服务器运维用；生产可由 Nginx 承担，此处保留便于排查）
  res.on("finish", () => {
    try {
      console.log(
        new Date().toISOString() + " " +
        clientIp(req) + " " +
        (req.headers["user-agent"] || "-").slice(0, 60) + " " +
        req.method + " " + url.slice(0, 120) + " → " + res.statusCode +
        " " + (Date.now() - started) + "ms"
      );
    } catch (e) { }
  });

  try {
    /* ---------- 健康检查（公开，供负载均衡探活）---------- */
    if (url.startsWith("/healthz")) {
      const health = {
        ok: true,
        service: "eve-aux-tool",
        version: APP_VERSION,
        // ★ 代码指纹：用于识别「端口上跑的是改动前的旧实例」
        fingerprint: CODE_FINGERPRINT,
        uptime: Math.round(process.uptime()),
        users: userSpace.listUsers().length,
        mode: MULTI_USER ? "multi-user" : "single-user"
      };
      return sendJSON(res, health, 200);
    }

    /* ---------- 登录 / 注册（仅多用户模式）---------- */
    if (url.startsWith("/api/login")) {
      return await apiLogin(req, res, q);
    }
    if (url.startsWith("/api/register")) {
      return await apiRegister(req, res, q);
    }
    if (url.startsWith("/api/logout")) {
      return apiLogout(req, res);
    }

    /* ---------- 以下均需鉴权 ---------- */
    const user = currentUser(req);
    if (!user) {
      // 页面请求返回登录页，接口请求返回 401
      if (req.headers.accept && req.headers.accept.includes("text/html") && !url.startsWith("/api/")) {
        return sendHTML(res, loginPage(), 401);
      }
      return sendJSON(res, { ok: false, error: "未登录或会话已过期", needLogin: true }, 401);
    }
    const auth = authFor(user);
    const profiles = profilesFor(user);

    // SSO
    if (url.startsWith("/sso/start")) return await ssoStart(req, res, url, q, user);
    if (url.startsWith("/sso/callback")) return await ssoCallback(req, res, url, q, user);

    // ESI 代理
    if (url.startsWith("/esi/")) return await esiProxy(req, res, url, user);

    /* ---------- EIV 基准价（工业成本基准，一次返回全量）---------- */
    if (url.startsWith("/api/eiv")) {
      const key = q.server || "serenity";
      const data = fetcher.eivOf(key);
      const n = Object.keys(data).length;
      if (!n) {
        return sendJSON(res, {
          ok: false,
          error: "本地暂无 " + key + " 的 EIV 基准价缓存，可先在「市场」页查询一次以触发拉取"
        }, 404);
      }
      return sendJSON(res, { ok: true, server: key, count: n, prices: data });
    }

    // 业务接口
    if (url.startsWith("/api/config")) {
      if (req.method === "POST") return await apiConfigSave(req, res, user);
      return apiConfig(req, res, user);
    }
    if (url.startsWith("/api/sync") && req.method === "POST") return await apiSync(req, res, user, auth, profiles);
    if (url.startsWith("/api/skills/manual") && req.method === "POST") {
      return await apiSkillsManual(req, res, user, profiles);
    }
    if (url.startsWith("/api/auth/manual")) {
      if (req.method === "POST") return await apiManualAuth(req, res, user);
      return apiManualAuthLink(req, res, user, q);
    }
    if (url.startsWith("/api/profiles")) {
      if (req.method === "DELETE") return apiProfileDelete(req, res, url, q, profiles);
      return apiProfiles(req, res, profiles);
    }

    // 静态资源（公开：页面与数据表不含敏感信息）
    // ★ 用 url 的路径部分判断（去掉查询串）——
    //   否则 `/?openpanel=1` 这类带参数的首页链接会 404。
    const pathOnly = url.split("?")[0];
    if (pathOnly === "/" || pathOnly === "/index.html") {
      return serveFile(res, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
    }
    if (url.startsWith("/data/")) {
      const name = path.basename(url.split("?")[0]);
      const file = path.join(DATA_DIR, name);
      if (!file.startsWith(DATA_DIR)) return sendJSON(res, { ok: false, error: "非法路径" }, 400);
      if (fs.existsSync(file)) {
        return serveFile(res, file, "application/json; charset=utf-8");
      }
      return sendJSON(res, { ok: false, error: "数据表不存在：" + name }, 404);
    }

    // 前端静态
    const safe = path.normalize(url.split("?")[0]).replace(/^([/\\])+/, "");
    const f = path.join(ROOT, safe);
    if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      const ct = f.endsWith(".html") ? "text/html; charset=utf-8"
        : f.endsWith(".js") ? "application/javascript; charset=utf-8"
        : f.endsWith(".css") ? "text/css; charset=utf-8"
        : "application/octet-stream";
      return serveFile(res, f, ct);
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("未找到");
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
});

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
let currentPort = PORT;
server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && currentPort < PORT + 20) {
    currentPort += 1;
    console.log("端口 " + (currentPort - 1) + " 被占用，改用 " + currentPort);
    server.listen(currentPort, HOST);
  } else {
    console.error("启动失败：" + err.message);
    process.exit(1);
  }
});
server.listen(currentPort, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "本机全部网卡" : HOST;
  console.log("EVE 辅助工具 已在 http://" + shown + ":" + currentPort + " 运行");
  console.log("授权回调：" + defaultRedirectUri(currentPort));
  console.log("运行模式：" + (MULTI_USER ? "多用户（需注册登录）" : "单用户（本地开发，不校验口令）"));
  console.log("健康检查：http://" + shown + ":" + currentPort + "/healthz");
  if (!CLIENT_ID && !cfg.clientId) {
    console.log("提示：尚未配置 Client ID —— 在工具的「设置」页填写，或设置环境变量 EVE_CLIENT_ID");
  }
  if (HOST === "0.0.0.0" && !MULTI_USER) {
    console.warn("★ 警告：监听 0.0.0.0 但未设置 EVE_SECRET —— 任何人都可访问本服务，请勿暴露到公网");
  }
  console.log("按 Ctrl+C 停止。");
});

/* 优雅关闭：等待进行中的请求完成再退出（systemd stop 会发 SIGTERM） */
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n收到 " + signal + "，正在关闭（最多等待 10 秒）…");
  const timer = setTimeout(() => {
    console.log("等待超时，强制退出");
    process.exit(1);
  }, 10000);
  timer.unref();
  server.close(() => {
    console.log("已关闭");
    process.exit(0);
  });
  // 主动断开长连接
  if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

/** 取真实客户端 IP（置于反向代理后时） */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",")[0].trim();
    const rip = req.headers["x-real-ip"];
    if (rip) return String(rip).trim();
  }
  return req.socket ? req.socket.remoteAddress : "";
}

module.exports = { server, userSpace, authFor, profilesFor, currentUser, APP_VERSION };
