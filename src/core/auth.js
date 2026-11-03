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

/* ------------------------------------------------------------------ *
 * 令牌落盘加密（AES-256-GCM）
 * ------------------------------------------------------------------ */

/**
 * 加密对象为 JSON 文本。
 * 格式： { __enc: "gcm", iv, tag, data }（均为 base64）
 */
function encryptJson(obj, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const text = Buffer.from(JSON.stringify(obj), "utf8");
  const enc = Buffer.concat([cipher.update(text), cipher.final()]);
  return {
    __enc: "gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64")
  };
}

/** 解密 encryptJson 的产物 */
function decryptJson(box, key) {
  if (!box || box.__enc !== "gcm") throw new Error("不是加密数据");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key,
    Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(box.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(dec.toString("utf8"));
}

/** 从任意字符串派生 32 字节密钥（SHA-256） */
function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest();
}

/* ------------------------------------------------------------------ *
 * 网易官方公共 ESI 应用的 Client ID 与回调地址
 * ------------------------------------------------------------------ */
const OFFICIAL_CN_CLIENT_ID = "bc90aa496a404724a93f41b4f4e97761";
const OFFICIAL_CN_REDIRECT_URI = "https://esi.evepc.163.com/ui/oauth2-redirect.html";

/**
 * 把上游返回的英文错误翻译成可操作的中文提示。
 *
 * ★ 实证（2026-11-03）：国服 authorize 在浏览器持有失效网易 Cookie 时
 * 会返回 invalid_request + "Missing Netease token" —— 根因是服务端把
 * 旧 Cookie 当成「已登录」而去做 RealID 绑定校验，与本工具的请求参数无关。
 *
 * ★ 实证（2026-11-03）：国服在**登录之后**校验 redirect_uri，
 *   若 Client ID 登记的回调地址与本工具上报的不一致，返回
 *   「The redirect URL does not match any of the configured values for this client」。
 *   最常见的两种成因：
 *     1) 用的是网易官方公共 Client ID（bc90aa49…），
 *        它只认 https://esi.evepc.163.com/ui/oauth2-redirect.html
 *     2) 服务端口被占用后自动 +1 顺延，但回调地址仍按旧端口上报
 */
function explainAuthError(msg, ctx) {
  const s = String(msg || "");
  ctx = ctx || {};

  if (/Missing Netease token|Unable to check RealID/i.test(s)) {
    return "浏览器中残留了失效的网易账号 Cookie，服务端误判为已登录而无法完成实名认证校验。" +
      "请清除 login.evepc.163.com 的 Cookie（或改用无痕窗口 / 另一浏览器）后重新发起授权。" +
      "（原始信息：" + s + "）";
  }

  if (/redirect URL does not match|redirect_uri|invalid_request/i.test(s)
      && /redirect/i.test(s)) {
    const lines = [];
    lines.push("回调地址与该 Client ID 在后台登记的地址不匹配（网易在登录之后才校验 redirect_uri，所以登录前一切正常）。");
    lines.push("本工具本次上报的回调地址是：" + (ctx.redirectUri || "（未知）"));
    lines.push("");
    if (ctx.usingOfficialClientId) {
      lines.push("★ 你用的是网易官方公共 Client ID（" + OFFICIAL_CN_CLIENT_ID + "）。");
      lines.push("  它在网易后台只登记了一个回调地址：" + OFFICIAL_CN_REDIRECT_URI);
      lines.push("  本地工具无法用它做标准授权流程。可选做法：");
      lines.push("   A. 在「设置」页为该服改填**你自己在网易开发者后台注册的** Client ID，");
      lines.push("      并把回调地址登记为 " + (ctx.redirectUri || "http://localhost:8657/sso/callback"));
      lines.push("   B. 沿用官方 Client ID，把回调地址改为 " + OFFICIAL_CN_REDIRECT_URI + "，");
      lines.push("      授权后从浏览器地址栏取回 #access_token=… 片段（本工具暂不自动解析该片段）。");
    } else {
      lines.push("常见成因：");
      lines.push(" 1) 端口被占用后本工具自动顺延到了别的端口，但你在后台登记的仍是旧端口的地址；");
      lines.push("    → 请确认「设置」页/启动日志显示的回调地址与后台登记的完全一致（协议、主机、端口、路径都一致）。");
      lines.push(" 2) 曙光服是独立集群，需要**单独注册**应用，不能与晨曦共用同一个 Client ID；");
      lines.push("    → 请在网易开发者后台为曙光单独建应用，并把该服的 Client ID 填到「设置」页对应服。");
      lines.push(" 3) 后台登记的地址末尾多了一个斜杠（http://localhost:8657/sso/callback/ 与 …/sso/callback 不同）；");
      lines.push("    → 逐字符核对，末尾斜杠也算差异。");
    }
    lines.push("（原始信息：" + s + "）");
    return lines.join("\n");
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
    // 令牌落盘加密密钥（服务器部署时提供，磁盘上不存明文令牌）
    this.encryptionKey = opts.encryptionKey || null;
    // 绑定的用户存储（多用户隔离）
    this.store = opts.store || null;
    this.tokens = this.store ? this._restoreFrom(this.store) : this._load();
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
    // 绑定了用户存储 → 走按用户隔离的（可加密的）持久化
    if (this.store) return this._persistTo(this.store);
    try {
      if (!fs.existsSync(TOKEN_DIR)) fs.mkdirSync(TOKEN_DIR, { recursive: true });
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(this.tokens, null, 2), "utf8");
      // 收紧权限（若平台支持）
      try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) { /* Windows 忽略 */ }
    } catch (e) { /* 持久化失败不影响本次会话 */ }
  }

  /* ---------------- 令牌落盘加密 ---------------- */

  /**
   * 把令牌写入用户存储。
   * 服务器部署时启用 AES-256-GCM 加密 —— 磁盘上的 EVE 令牌不再是明文，
   * 即使文件泄露也无法直接使用。
   */
  _persistTo(store) {
    if (!store) return;
    const payload = this.encryptionKey
      ? encryptJson(this.tokens, this.encryptionKey)
      : this.tokens;
    try { store.saveTokens(payload); } catch (e) { }
  }

  /**
   * 从用户存储读回令牌。
   * 自动识别明文与密文两种格式（密文带 __enc 标记），兼容迁移期。
   */
  _restoreFrom(store) {
    if (!store) return {};
    let data;
    try { data = store.tokens(); } catch (e) { return {}; }
    if (!data || typeof data !== "object") return {};
    if (data.__enc) {
      try {
        const plain = decryptJson(data, this.encryptionKey);
        delete plain.__enc;
        return plain;
      } catch (e) {
        console.error("令牌解密失败（可能是 EVE_SALT 已变更）：" + e.message);
        return {};
      }
    }
    return data;
  }

  /* ---------------- 步骤 1：发起授权 ---------------- */

  /**
   * 构造错误提示用的上下文：本次上报的回调地址 + 是否用了网易官方公共 ID。
   */
  _errorCtx(serverKey) {
    return {
      serverKey: serverKey || this.serverKey || null,
      redirectUri: this.redirectUri || null,
      usingOfficialClientId: String(this.clientId || "").trim().toLowerCase() === OFFICIAL_CN_CLIENT_ID
    };
  }

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
      throw new Error("令牌交换失败 HTTP " + res.status + "：" +
        explainAuthError(msg, this._errorCtx(pending.serverKey)));
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
      throw new Error("刷新失败 HTTP " + res.status + "：" +
        explainAuthError(msg, this._errorCtx(rec.serverKey)));
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
  encryptJson,
  decryptJson,
  deriveKey,
  TOKEN_FILE,
  TOKEN_DIR
};
