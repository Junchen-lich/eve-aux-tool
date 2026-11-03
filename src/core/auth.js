/*
 * EVE 辅助工具 —— SSO 授权模块（PKCE）
 * Copyright (C) 2026 Junchen-lich
 *
 * ★ 三服差异（实测 2026-11-03）
 *
 *   欧服（宁静）login.eveonline.com
 *     · authorize 支持 GET → 浏览器可直接跳转
 *     · token     POST form-urlencoded
 *     · 桌面应用用 PKCE（Authorization Code + PKCE），不硬编码 client secret
 *
 *   国服（晨曦 / 曙光）login.evepc.163.com
 *     · authorize 支持 GET（浏览器可直接跳转，已用真实浏览器验证）
 *       ※ 早期「只支持 POST」的结论来自 curl 探测缺少必填参数，属误判
 *     · 必填参数含国服特有的 realm 与 device_id（任意值即可）
 *     · scope 一次最多 4 项
 *     · token     POST form-urlencoded（缺凭据时返回 invalid_client）
 *     · 同样支持 PKCE
 *
 * ★ 已知问题：浏览器内残留的失效网易 Cookie 会让 authorize 直接返回
 *   {"error":"invalid_request","error_description":"Unable to check RealID
 *   binding if user isn't logged in. Missing Netease token."}
 *   —— 服务端因收到旧 Cookie 而误判「已登录」，继而检查 RealID 绑定失败。
 *   清除该域名 Cookie 或换用干净浏览器即可；详见 explainAuthError()。
 *
 * ★ 令牌机制
 *   · access_token 有效期约 20 分钟（expires_in ≈ 1200）
 *   · refresh_token 长期有效，需持久化
 *   · JWT 的 sub 字段形如 "CHARACTER:EVE:12345"，可解析出角色 ID
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SERVERS } = require("./servers.js");

const ROOT = path.join(__dirname, "..", "..");
const TOKEN_DIR = path.join(ROOT, "用户数据");
const TOKEN_FILE = path.join(TOKEN_DIR, "eve_auth_v1.json");

/* ------------------------------------------------------------------ *
 * PKCE 工具
 * ------------------------------------------------------------------ */
function base64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成 code_verifier 与 code_challenge（S256） */
function createPkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

/**
 * 把上游返回的英文错误翻译成可操作的中文提示。
 *
 * ★ 实证（2026-11-03）：国服 authorize 在浏览器持有失效网易 Cookie 时
 * 会返回 invalid_request + "Missing Netease token" —— 根因是服务端把
 * 旧 Cookie 当成「已登录」而去做 RealID 绑定校验，与本工具的请求参数无关。
 */
function explainAuthError(msg) {
  const s = String(msg || "");
  if (/Missing Netease token|Unable to check RealID/i.test(s)) {
    return "浏览器中残留了失效的网易账号 Cookie，服务端误判为已登录而无法完成实名认证校验。" +
      "请清除 login.evepc.163.com 的 Cookie（或改用无痕窗口 / 另一浏览器）后重新发起授权。" +
      "（原始信息：" + s + "）";
  }
  if (/invalid_client/i.test(s)) {
    return "Client ID 无效或该服不支持此授权方式。" +
      "国服请使用网易公共 Client ID；欧服需在 developers.eveonline.com 自行注册。" +
      "（原始信息：" + s + "）";
  }
  if (/invalid_grant|expired/i.test(s)) {
    return "授权码已失效或已被使用，请重新发起授权。" +
      "（原始信息：" + s + "）";
  }
  if (/redirect_uri|invalid_request/i.test(s)) {
    return "回调地址不被该 Client ID 接受，请检查 redirectUri 配置。" +
      "（原始信息：" + s + "）";
  }
  return s;
}

/** 生成 state（防 CSRF） */
function createState() {
  return base64url(crypto.randomBytes(16));
}

/** 从 JWT 的 sub 字段解析角色 ID： "CHARACTER:EVE:12345" → 12345 */
function characterIdFromToken(accessToken) {
  try {
    const parts = String(accessToken).split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const sub = payload.sub || "";
    const m = sub.match(/CHARACTER:EVE:(\d+)/);
    return m ? Number(m[1]) : null;
  } catch (e) {
    return null;
  }
}

/** 读取 JWT 载荷（用于展示角色名等） */
function decodeToken(accessToken) {
  try {
    const parts = String(accessToken).split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 授权流程
 * ------------------------------------------------------------------ */
class AuthManager {
  /**
   * @param {object} opts
   *  clientId   应用 Client ID（在 EVE 开发者后台注册获得）
   *  redirectUri 本地回调地址，须与注册时一致
   *  serverKey  默认服务器
   */
  constructor(opts) {
    opts = opts || {};
    this.clientId = opts.clientId || "";
    this.clientSecret = opts.clientSecret || "";
    this.redirectUri = opts.redirectUri || "http://localhost:8657/sso/callback";
    this.serverKey = opts.server || "serenity";
    this.pending = new Map();   // state → { verifier, serverKey, createdAt }
    this.tokens = this._load();
  }

  /* ---------------- 令牌持久化 ---------------- */

  _load() {
    try {
      if (!fs.existsSync(TOKEN_FILE)) return {};
      const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch (e) {
      return {};
    }
  }

  _save() {
    try {
      if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(this.tokens, null, 2), "utf8");
      // 收紧权限（若平台支持）
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) { /* Windows 忽略 */ }
    } catch (e) { /* 持久化失败不影响本次会话 */ }
  }

  /* ---------------- 步骤 1：发起授权 ---------------- */

  /**
   * 生成授权 URL
   * @param {string} serverKey 服务器
   * @param {string[]} scopes 申请的 scope
   * @returns {{ url, state, method, form }}
   *   method=GET  → url 可直接跳转
   *   method=POST → form 为需提交的表单字段（服务端转发用）
   */
  buildAuthorize(serverKey, scopes) {
    const cfg = SERVERS[serverKey];
    if (!cfg) throw new Error("未知服务器：" + serverKey);
    if (!this.clientId) throw new Error("未配置 Client ID");

    // scope 数量上限（国服一次最多 4 项）
    const max = cfg.maxScopes || 0;
    if (max && scopes.length > max) {
      throw new Error(
        SERVERS[serverKey].label + " 一次最多申请 " + max + " 项权限，当前请求了 " +
        scopes.length + " 项。请分批授权，或只保留核心权限：\n" + scopes.join("\n"));
    }

    const pkce = createPkce();
    const state = createState();
    this.pending.set(state, {
      verifier: pkce.verifier,
      serverKey,
      createdAt: Date.now()
    });
    // 清理过期 pending（10 分钟）
    const now = Date.now();
    for (const [k, v] of this.pending) {
      if (now - v.createdAt > 10 * 60 * 1000) this.pending.delete(k);
    }

    const params = Object.assign({
      response_type: "code",
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      scope: scopes.join(" "),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: pkce.method
    }, cfg.ssoExtraParams || {});

    return {
      url: cfg.ssoAuthorize + "?" + new URLSearchParams(params).toString(),
      state,
      method: cfg.ssoAuthorizeMethod || "GET",
      form: params,
      serverKey
    };
  }

  /* ---------------- 步骤 2：处理回调 ---------------- */

  /**
   * 用授权码换取令牌
   * @param {string} code  授权码
   * @param {string} state 状态（用于匹配 pending）
   * @param {string} serverKey 服务器（可选，优先用 state 记录的）
   */
  async exchangeCode(code, state, serverKey) {
    const pending = this.pending.get(state);
    if (!pending) throw new Error("state 无效或已过期，请重新发起授权");
    this.pending.delete(state);

    const cfg = SERVERS[pending.serverKey];
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      code_verifier: pending.verifier
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    // 国服特有参数（realm / device_id）
    for (const [k, v] of Object.entries(cfg.ssoExtraParams || {})) {
      if (!body.has(k)) body.set(k, v);
    }

    const res = await fetch(cfg.ssoToken, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "EVE-AuxTool/0.1"
      },
      body: body.toString()
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error_description || JSON.parse(text).error || text; } catch (e) { }
      throw new Error("令牌交换失败 HTTP " + res.status + "：" + explainAuthError(msg));
    }
    const data = JSON.parse(text);
    const rec = this._store(data, pending.serverKey);
    return rec;
  }

  _store(data, serverKey) {
    const charId = characterIdFromToken(data.access_token);
    const payload = decodeToken(data.access_token);
    const rec = {
      serverKey,
      characterId: charId,
      characterName: payload ? (payload.name || null) : null,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: Date.now() + (Number(data.expires_in) || 1200) * 1000,
      updated: Date.now()
    };
    // 以「服务器 + 角色 ID」为键
    const key = serverKey + ":" + (charId || rec.characterName || "unknown");
    this.tokens[key] = rec;
    this._save();
    return rec;
  }

  /* ---------------- 步骤 3：刷新 ---------------- */

  /**
   * 刷新访问令牌
   * @param {string} key 令牌键
   */
  async refresh(key) {
    const rec = this.tokens[key];
    if (!rec) throw new Error("令牌不存在：" + key);
    if (!rec.refreshToken) throw new Error("无 refresh token，无法刷新");
    const cfg = SERVERS[rec.serverKey];

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rec.refreshToken,
      client_id: this.clientId
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    for (const [k, v] of Object.entries(cfg.ssoExtraParams || {})) {
      if (!body.has(k)) body.set(k, v);
    }

    const res = await fetch(cfg.ssoToken, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "EVE-AuxTool/0.1"
      },
      body: body.toString()
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = JSON.parse(text).error_description || JSON.parse(text).error || text; } catch (e) { }
      throw new Error("刷新失败 HTTP " + res.status + "：" + explainAuthError(msg));
    }
    const data = JSON.parse(text);
    // 刷新时可能不返回新的 refresh_token，需保留旧的
    if (!data.refresh_token) data.refresh_token = rec.refreshToken;
    return this._store(data, rec.serverKey);
  }

  /**
   * 取有效令牌（必要时自动刷新）
   */
  async getValidToken(key) {
    const rec = this.tokens[key];
    if (!rec) throw new Error("令牌不存在：" + key);
    const remain = rec.expiresAt - Date.now();
    if (remain > 60000) return rec.accessToken;      // 剩余 >60 秒，直接用
    if (remain > -300000 && rec.refreshToken) {      // 刚过期或即将过期 → 刷新
      const updated = await this.refresh(key);
      return updated.accessToken;
    }
    throw new Error("令牌已过期且无法刷新，请重新授权");
  }

  /** 列出所有已保存的角色 */
  list() {
    return Object.entries(this.tokens).map(([key, rec]) => ({
      key,
      serverKey: rec.serverKey,
      // 前台显示中文标签
      serverLabel: SERVERS[rec.serverKey] ? SERVERS[rec.serverKey].label : rec.serverKey,
      characterId: rec.characterId,
      characterName: rec.characterName,
      expiresAt: rec.expiresAt,
      expired: rec.expiresAt < Date.now(),
      hasRefresh: !!rec.refreshToken
    }));
  }

  /** 删除某个角色的令牌 */
  remove(key) {
    if (this.tokens[key]) {
      delete this.tokens[key];
      this._save();
      return true;
    }
    return false;
  }

  /** 清除全部令牌 */
  clearAll() {
    this.tokens = {};
    this._save();
  }
}

module.exports = {
  AuthManager,
  createPkce,
  createState,
  characterIdFromToken,
  decodeToken,
  explainAuthError,
  TOKEN_FILE,
  TOKEN_DIR
};
