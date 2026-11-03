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
const { AuthManager } = require("./src/core/auth.js");
const { ProfileStore } = require("./src/core/profiles.js");
const { EsiClient } = require("./src/core/esi-client.js");
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

/** 回调地址：BASE_URL 优先，否则由监听地址推导 */
function defaultRedirectUri() {
  if (BASE_URL) return BASE_URL + "/sso/callback";
  const hostPart = (HOST === "0.0.0.0" || HOST === "::") ? "localhost" : HOST;
  return "http://" + hostPart + ":" + PORT + "/sso/callback";
}
const REDIRECT_URI = process.env.EVE_REDIRECT_URI || defaultRedirectUri();

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

/* 按用户隔离的鉴权与档案存取 */
function authFor(user) {
  const auth = new AuthManager({
    clientId: user.store.meta().clientId || cfg.clientId || CLIENT_ID,
    clientSecret: user.store.meta().clientSecret || cfg.clientSecret || "",
    redirectUri: REDIRECT_URI,
    // 服务器部署时用盐派生密钥，令牌落盘加密
    encryptionKey: ENCRYPTION_KEY,
    store: user.store
  });
  return auth;
}

function persistAuth(user, auth) {
  if (user.store) { try { auth._save(); } catch (e) { } }
}

function profilesFor(user) {
  const ps = new ProfileStore();
  ps.profiles = user.store.profiles();
  ps.save = function () {
    try { user.store.saveProfiles(this.profiles); } catch (e) { }
  };
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
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
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
async function ssoStart(req, res, url, q, user) {
  const serverKey = q.server || "serenity";
  const scopes = (q.scope || "esi-skills.read_skills.v1").split(",").map(s => s.trim()).filter(Boolean);
  try {
    const auth = authFor(user);
    const au = auth.buildAuthorize(serverKey, scopes);
    // ★ 授权状态按用户隔离：多用户同时授权时 state 不会互相覆盖
    user.store.savePending && user.store.savePending(au.state, {
      verifier: au.form ? au.form.code_verifier : null,
      serverKey
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
    const auth = authFor(user);
    const rec = await auth.exchangeCode(code, state);
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
function apiConfig(req, res) {
  sendJSON(res, {
    ok: true,
    clientIdConfigured: !!(cfg.clientId || CLIENT_ID),
    redirectUri: REDIRECT_URI,
    baseUrl: BASE_URL || null,
    multiUser: MULTI_USER,
    servers: SERVER_ORDER.map(k => ({
      key: k,
      label: SERVERS[k].label,
      short: SERVERS[k].short,
      esiBase: SERVERS[k].esiBase,
      authorizeMethod: SERVERS[k].ssoAuthorizeMethod
    }))
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
      industryJobs: profile.industryJobs
    });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/** GET /api/profiles —— 角色档案列表（前台中文展示） */
function apiProfiles(req, res, profiles) {
  sendJSON(res, { ok: true, profiles: profiles.list() });
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
async function esiProxy(req, res, url, auth) {
  const m = url.match(/^\/esi\/([a-z]+)\/(.*)$/);
  if (!m) return sendJSON(res, { ok: false, error: "路径格式应为 /esi/{server}/{path}" }, 400);
  const [, serverKey, rest] = m;
  if (!SERVERS[serverKey]) return sendJSON(res, { ok: false, error: "未知服务器" }, 400);

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
    if (url.startsWith("/esi/")) return await esiProxy(req, res, url, auth);

    // 业务接口
    if (url.startsWith("/api/config")) {
      if (req.method === "POST") return await apiConfigSave(req, res, user);
      return apiConfig(req, res);
    }
    if (url.startsWith("/api/sync") && req.method === "POST") return await apiSync(req, res, user, auth, profiles);
    if (url.startsWith("/api/profiles")) {
      if (req.method === "DELETE") return apiProfileDelete(req, res, url, q, profiles);
      return apiProfiles(req, res, profiles);
    }

    // 静态资源（公开：页面与数据表不含敏感信息）
    if (url === "/" || url === "/index.html") {
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
  console.log("授权回调：" + REDIRECT_URI);
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
