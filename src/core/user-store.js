/*
 * EVE 辅助工具 —— 用户存储层（多用户隔离）
 * Copyright (C) 2026 Junchen-lich
 *
 * ★ 为什么需要这一层
 *
 *   v1 假设「单机单人」：令牌与角色档案各存一个全局 JSON。
 *   一旦作为公共服务部署，所有访问者共用同一份文件 —— A 用户会看到 B 用户的
 *   角色数据与令牌，这是不可接受的越权。
 *
 * ★ 设计
 *
 *   用户数据/
 *     users/
 *       <userId>/
 *         meta.json          用户元信息（创建时间、昵称、最后活跃）
 *         auth.json           该用户的令牌集合（按 serverKey:characterId）
 *         profiles.json       该用户的角色档案
 *
 *   userId 由「登录口令 + 服务端盐」派生，浏览器只持有一个签名 Cookie，
 *   服务端据此定位目录。攻击者无法通过猜测 userId 直接读取他人文件。
 *
 * ★ 与单文件方案的兼容
 *
 *   旧的单文件（用户数据/eve_auth_v1.json、eve_char_profiles_v1.json）保留可读，
 *   首次以本地模式运行时自动迁移进 users/local/ 目录，不丢用户已有数据。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const DATA_ROOT = path.join(ROOT, "用户数据");
const USERS_DIR = path.join(DATA_ROOT, "users");

/** 旧版单文件路径（用于迁移） */
const LEGACY_FILES = {
  auth: path.join(DATA_ROOT, "eve_auth_v1.json"),
  profiles: path.join(DATA_ROOT, "eve_char_profiles_v1.json")
};

/** 默认本地用户 ID（单用户模式） */
const LOCAL_USER = "local";

function nowIso() {
  return new Date().toISOString();
}

/** 安全比较，避免时序攻击 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 由用户名派生用户 ID。
 * ★ userId 只与「用户名 + 盐」有关，与口令无关 ——
 *   口令是可变的（可改密码），用户名才是身份。
 * @param {string} username 用户名
 * @param {string} salt     服务端盐
 * @returns {string} 形如 "u_a1b2c3d4..." 的用户标识
 */
function deriveUserId(username, salt) {
  const h = crypto.createHash("sha256");
  h.update(String(salt || ""));
  h.update("\x00");
  h.update(String(username || "").trim().toLowerCase());
  return "u_" + h.digest("hex").slice(0, 32);
}

/** 校验用户 ID 格式（防止路径穿越） */
function isValidUserId(id) {
  return typeof id === "string" && /^u_[0-9a-f]{32}$/.test(id);
}

/**
 * 口令哈希（scrypt）。
 * 格式： scrypt$N$r$p$hashB64
 * 每用户独立随机盐（存于 meta.json 的 pwSalt），不进哈希串本身。
 */
function hashPassword(password, salt) {
  const N = 16384, r = 8, p = 1;
  const key = crypto.scryptSync(String(password || ""), String(salt || ""), 32,
    { N, r, p, maxmem: 64 * 1024 * 1024 });
  return "scrypt$" + N + "$" + r + "$" + p + "$" + key.toString("base64");
}

/** 校验口令（常量时间比较） */
function verifyPassword(password, stored, salt) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 5 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    const expect = Buffer.from(parts[4], "base64");
    const key = crypto.scryptSync(String(password || ""), String(salt || ""), expect.length,
      { N, r, p, maxmem: 64 * 1024 * 1024 });
    return key.length === expect.length && crypto.timingSafeEqual(key, expect);
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 单个用户的存储
 * ------------------------------------------------------------------ */
class UserStore {
  /**
   * @param {string} userId  用户标识（须通过 isValidUserId 校验）
   * @param {string} baseDir 用户数据根目录
   */
  constructor(userId, baseDir) {
    this.userId = userId;
    this.dir = path.join(baseDir || USERS_DIR, userId);
    this.metaFile = path.join(this.dir, "meta.json");
    this.authFile = path.join(this.dir, "auth.json");
    this.profilesFile = path.join(this.dir, "profiles.json");
    this.pendingFile = path.join(this.dir, "pending.json");
  }

  _ensureDir() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** 读取 JSON 文件，损坏时返回默认值而非抛错 */
  _readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      return raw && typeof raw === "object" ? raw : fallback;
    } catch (e) {
      return fallback;
    }
  }

  /** 原子写入：先写临时文件再重命名，避免进程崩溃时写坏文件 */
  _writeJson(file, obj) {
    this._ensureDir();
    const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
    try {
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) { }
      throw e;
    }
  }

  /* ---------------- 元信息 ---------------- */

  meta() {
    const m = this._readJson(this.metaFile, {});
    if (!m.userId) {
      m.userId = this.userId;
      m.createdAt = m.createdAt || nowIso();
    }
    return m;
  }

  touch() {
    const m = this.meta();
    m.lastSeenAt = nowIso();
    try { this._writeJson(this.metaFile, m); } catch (e) { }
  }

  /* ---------------- 账户 ---------------- */

  /** 是否已设置口令 */
  hasPassword() {
    const m = this.meta();
    return !!(m.pwHash && m.pwSalt);
  }

  /** 设置（或修改）口令 */
  setPassword(password) {
    const m = this.meta();
    const salt = crypto.randomBytes(16).toString("base64");
    m.pwSalt = salt;
    m.pwHash = hashPassword(password, salt);
    m.pwUpdatedAt = nowIso();
    this._writeJson(this.metaFile, m);
    return m;
  }

  /** 校验口令 */
  verifyPassword(password) {
    const m = this.meta();
    if (!m.pwHash || !m.pwSalt) return false;
    return verifyPassword(password, m.pwHash, m.pwSalt);
  }

  /** 记录用户名（便于管理端识别） */
  setUsername(username) {
    const m = this.meta();
    m.username = String(username || "").trim();
    this._writeJson(this.metaFile, m);
    return m;
  }

  /* ---------------- 令牌 ---------------- */

  tokens() {
    return this._readJson(this.authFile, {});
  }

  saveTokens(tokens) {
    this._writeJson(this.authFile, tokens || {});
  }

  /* ---------------- 角色档案 ---------------- */

  profiles() {
    return this._readJson(this.profilesFile, {});
  }

  saveProfiles(profiles) {
    this._writeJson(this.profilesFile, profiles || {});
  }

  /* ---------------- 待完成授权 ---------------- */

  /**
   * 记录一次发起的授权（state → 服务器与校验器）。
   * 回调时凭 state 找回是哪一服，从而用该服自己的 Client ID 换令牌。
   */
  savePending(state, info) {
    if (!state) return;
    const all = this._readJson(this.pendingFile, {});
    all[state] = Object.assign({ createdAt: Date.now() }, info || {});
    // 清理 15 分钟前的过期记录
    const now = Date.now();
    for (const k of Object.keys(all)) {
      if (now - (all[k].createdAt || 0) > 15 * 60 * 1000) delete all[k];
    }
    this._writeJson(this.pendingFile, all);
  }

  /** 取一次待完成授权的记录 */
  pending(state) {
    if (!state) return null;
    const all = this._readJson(this.pendingFile, {});
    return all[state] || null;
  }

  /** 授权完成后清除记录 */
  clearPending(state) {
    if (!state) return;
    const all = this._readJson(this.pendingFile, {});
    if (all[state]) {
      delete all[state];
      this._writeJson(this.pendingFile, all);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 用户存储管理器
 * ------------------------------------------------------------------ */
class UserSpace {
  /**
   * @param {object} opts
   *   baseDir    用户数据根目录（默认 用户数据/users）
   *   salt       服务端盐
   *   singleUser 是否单用户模式（本地使用：不校验口令，所有人共用 local 用户）
   */
  constructor(opts) {
    opts = opts || {};
    this.baseDir = opts.baseDir || USERS_DIR;
    this.singleUser = !!opts.singleUser;
    this.salt = opts.salt || this._loadOrCreateSalt();
    this._migrated = false;
  }

  /** 盐持久化到文件，保证重启后用户 ID 不变 */
  _loadOrCreateSalt() {
    const f = path.join(DATA_ROOT, "server_salt.txt");
    try {
      if (fs.existsSync(f)) {
        const s = fs.readFileSync(f, "utf8").trim();
        if (s) return s;
      }
      const s = crypto.randomBytes(32).toString("hex");
      if (!fs.existsSync(DATA_ROOT)) fs.mkdirSync(DATA_ROOT, { recursive: true });
      fs.writeFileSync(f, s, { encoding: "utf8", mode: 0o600 });
      return s;
    } catch (e) {
      // 落盘失败时退化为进程级随机盐（重启后用户 ID 会变，需提示）
      return crypto.randomBytes(32).toString("hex");
    }
  }

  /** 由用户名得到用户 ID */
  userIdFor(username) {
    if (this.singleUser) return LOCAL_USER;
    return deriveUserId(username, this.salt);
  }

  /**
   * 注册新用户。
   * @returns {{ok:boolean, userId?:string, error?:string}}
   */
  register(username, password) {
    const name = String(username || "").trim();
    if (!/^[A-Za-z0-9_一-龥.-]{2,32}$/.test(name)) {
      return { ok: false, error: "用户名需为 2-32 位字母、数字、下划线、点或中文" };
    }
    if (!password || String(password).length < 6) {
      return { ok: false, error: "口令至少 6 位" };
    }
    const uid = this.userIdFor(name);
    const store = this.store(uid);
    if (store.hasPassword()) {
      return { ok: false, error: "该用户名已被注册" };
    }
    store.setUsername(name);
    store.setPassword(password);
    return { ok: true, userId: uid };
  }

  /**
   * 认证用户。
   * @returns {{ok:boolean, userId?:string, error?:string}}
   */
  authenticate(username, password) {
    const name = String(username || "").trim();
    if (!name || !password) return { ok: false, error: "请填写用户名与口令" };
    const uid = this.userIdFor(name);
    const store = this.store(uid);
    if (!store.hasPassword()) {
      return { ok: false, error: "用户名或口令不正确" };
    }
    if (!store.verifyPassword(password)) {
      return { ok: false, error: "用户名或口令不正确" };
    }
    store.touch();
    return { ok: true, userId: uid };
  }

  /** 修改口令 */
  changePassword(username, oldPassword, newPassword) {
    const r = this.authenticate(username, oldPassword);
    if (!r.ok) return r;
    if (!newPassword || String(newPassword).length < 6) {
      return { ok: false, error: "新口令至少 6 位" };
    }
    this.store(r.userId).setPassword(newPassword);
    return { ok: true, userId: r.userId };
  }

  /** 取某用户的存储对象 */
  store(userId) {
    if (!isValidUserId(userId) && userId !== LOCAL_USER) {
      throw new Error("非法用户标识");
    }
    return new UserStore(userId, this.baseDir);
  }

  /** 列出全部用户（管理用，不含敏感数据） */
  listUsers() {
    const out = [];
    try {
      if (!fs.existsSync(this.baseDir)) return out;
      for (const name of fs.readdirSync(this.baseDir)) {
        if (!isValidUserId(name) && name !== LOCAL_USER) continue;
        const s = new UserStore(name, this.baseDir);
        const m = s.meta();
        out.push({
          userId: name,
          createdAt: m.createdAt || null,
          lastSeenAt: m.lastSeenAt || null,
          label: m.label || null
        });
      }
    } catch (e) { }
    return out;
  }

  /**
   * 首次运行时把旧版单文件迁入 local 用户目录。
   * 幂等：已迁移过则直接返回。
   */
  migrateLegacy() {
    if (this._migrated) return false;
    this._migrated = true;
    try {
      if (!fs.existsSync(DATA_ROOT)) return false;
      const s = new UserStore(LOCAL_USER, this.baseDir);
      let did = false;
      for (const [kind, legacy] of Object.entries(LEGACY_FILES)) {
        if (!fs.existsSync(legacy)) continue;
        const target = kind === "auth" ? s.authFile : s.profilesFile;
        if (fs.existsSync(target)) continue;   // 已有新数据，不覆盖
        const data = this._readJson(legacy, null);
        if (!data) continue;
        s._writeJson(target, data);
        did = true;
      }
      if (did) {
        const m = s.meta();
        m.migratedFrom = "legacy-single-file";
        m.migratedAt = nowIso();
        s._writeJson(s.metaFile, m);
      }
      return did;
    } catch (e) {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * 会话 Cookie
 * ------------------------------------------------------------------ */

/**
 * 签发会话 Cookie 值。
 * 值为 "userId.expiresAt.hmac"，HMAC 密钥为服务端盐。
 */
function signSession(userId, expiresAt, salt) {
  const payload = userId + "." + expiresAt;
  const mac = crypto.createHmac("sha256", salt).update(payload).digest("base64url");
  return payload + "." + mac;
}

/** 校验会话 Cookie，返回 userId 或 null */
function verifySession(cookieValue, salt, now) {
  if (!cookieValue) return null;
  const parts = String(cookieValue).split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, mac] = parts;
  if (!isValidUserId(uid) && uid !== LOCAL_USER) return null;
  const payload = uid + "." + exp;
  const expect = crypto.createHmac("sha256", salt).update(payload).digest("base64url");
  if (!safeEqual(mac, expect)) return null;
  const expNum = Number(exp);
  if (!expNum || expNum < (now || Date.now())) return null;
  return uid;
}

/** 解析 Cookie 头 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

module.exports = {
  UserStore,
  UserSpace,
  deriveUserId,
  isValidUserId,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  parseCookies,
  safeEqual,
  LOCAL_USER,
  USERS_DIR,
  DATA_ROOT
};
