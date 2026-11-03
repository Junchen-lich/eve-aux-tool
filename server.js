/*
 * EVE 辅助工具 —— 本地服务器
 * Copyright (C) 2026 Junchen-lich
 *
 * 职责：
 *   1. 静态托管前端页面与数据表
 *   2. /sso/*   SSO 授权流程（三服双通道，国服需 POST 转发）
 *   3. /esi/*   ESI 代理（携带用户令牌，统一错误额度调度）
 *   4. /api/*   本地业务接口（角色同步、档案管理等）
 *   5. /userdata/* 用户数据读写
 *
 * 零第三方依赖，仅用 Node 内置模块。
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

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data", "sde");
const PORT = Number(process.env.PORT) || 8657;
const CLIENT_ID = process.env.EVE_CLIENT_ID || "";
const REDIRECT_URI = process.env.EVE_REDIRECT_URI || ("http://localhost:" + PORT + "/sso/callback");

/* 应用配置存用户数据目录，便于用户改 */
const CONFIG_FILE = path.join(ROOT, "用户数据", "eve_config_v1.json");

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) { return {}; }
}

const cfg = loadConfig();
const auth = new AuthManager({
  clientId: cfg.clientId || CLIENT_ID,
  clientSecret: cfg.clientSecret || "",
  redirectUri: cfg.redirectUri || REDIRECT_URI
});
const profiles = new ProfileStore();

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
 *   国服：302 到本地 /sso/forward（因为国服 authorize 只接受 POST）
 */
async function ssoStart(req, res, url, q) {
  const serverKey = q.server || "serenity";
  const scopes = (q.scope || "esi-skills.read_skills.v1").split(",").map(s => s.trim()).filter(Boolean);
  try {
    const au = auth.buildAuthorize(serverKey, scopes);
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
async function ssoCallback(req, res, url, q) {
  const code = q.code;
  const state = q.state;
  if (!code) {
    return sendHTML(res, `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>授权失败</title></head>
<body style="font-family:system-ui,sans-serif;padding:40px">
<h2>授权失败</h2><p>未收到授权码。</p><p><a href="/">返回工具</a></p></body></html>`, 400);
  }
  try {
    const rec = await auth.exchangeCode(code, state);
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
    redirectUri: auth.redirectUri,
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
async function apiSync(req, res) {
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
function apiProfiles(req, res) {
  sendJSON(res, { ok: true, profiles: profiles.list() });
}

/** DELETE /api/profiles?key=... —— 删除档案 */
function apiProfileDelete(req, res, url, q) {
  const key = q.key;
  if (!key) return sendJSON(res, { ok: false, error: "缺少 key" }, 400);
  const p = profiles.remove(key);
  auth.remove(key);
  sendJSON(res, { ok: true, removed: p });
}

/** POST /api/config —— 保存 Client ID 等配置 */
async function apiConfigSave(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJSON(res, { ok: false, error: "请求体不是有效 JSON" }, 400); }
  try {
    if (!fs.existsSync(path.dirname(CONFIG_FILE))) fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(body, null, 2), "utf8");
    auth.clientId = body.clientId || "";
    auth.clientSecret = body.clientSecret || "";
    if (body.redirectUri) auth.redirectUri = body.redirectUri;
    sendJSON(res, { ok: true });
  } catch (e) {
    sendJSON(res, { ok: false, error: e.message }, 500);
  }
}

/**
 * /esi/* —— ESI 代理
 *   前端请求 /esi/serenity/status/ → 转发到该服 ESI
 *   可选头 X-Eve-Token-Key 指定用哪个已保存的令牌
 */
async function esiProxy(req, res, url) {
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

  try {
    // SSO
    if (url.startsWith("/sso/start")) return await ssoStart(req, res, url, q);
    if (url.startsWith("/sso/callback")) return await ssoCallback(req, res, url, q);

    // ESI 代理
    if (url.startsWith("/esi/")) return await esiProxy(req, res, url);

    // 业务接口
    if (url.startsWith("/api/config")) {
      if (req.method === "POST") return await apiConfigSave(req, res);
      return apiConfig(req, res);
    }
    if (url.startsWith("/api/sync") && req.method === "POST") return await apiSync(req, res);
    if (url.startsWith("/api/profiles")) {
      if (req.method === "DELETE") return apiProfileDelete(req, res, url, q);
      return apiProfiles(req, res);
    }

    // 静态资源
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
    server.listen(currentPort);
  } else {
    console.error("启动失败：" + err.message);
    process.exit(1);
  }
});
server.listen(currentPort, () => {
  // 端口回退后同步回调地址 —— 否则授权码会被回调到占用原端口的另一个服务
  if (!cfg.redirectUri && !process.env.EVE_REDIRECT_URI) {
    auth.redirectUri = "http://localhost:" + currentPort + "/sso/callback";
  }
  console.log("EVE 辅助工具 已在 http://localhost:" + currentPort + " 运行");
  console.log("授权回调：" + auth.redirectUri);
  if (!auth.clientId) {
    console.log("提示：尚未配置 Client ID —— 在工具的「设置」页填写，或设置环境变量 EVE_CLIENT_ID");
  }
  console.log("按 Ctrl+C 停止。");
});

module.exports = { server, auth, profiles };
