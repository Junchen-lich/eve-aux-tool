/*
 * EVE 辅助工具 —— ESI 客户端
 * Copyright (C) 2026 Junchen-lich
 *
 * 封装官方 ESI 访问，三服统一入口：
 *   - 公开数据免鉴权
 *   - 认证数据走各服自己的 SSO（欧服 login.eveonline.com / 国服 login.evepc.163.com）
 *   - 遵守 ESI 错误额度（欧服 100 / 国服 50），超限时等待而非重试
 *   - 分页自动翻页（X-Pages 头）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { SERVERS, ESI } = require("./servers.js");

const UA = "EVE-AuxTool/0.1 (local desktop tool)";

class EsiClient {
  /**
   * @param {object} opts
   *  server     服务器键：serenity / shuguang / tranquility
   *  token      访问令牌（可后续刷新）
   *  onLimit    错误额度回调（remain, resetSeconds）
   */
  constructor(opts) {
    opts = opts || {};
    this.serverKey = opts.server || "serenity";
    this.cfg = SERVERS[this.serverKey];
    if (!this.cfg) throw new Error("未知服务器：" + this.serverKey);
    this.token = opts.token || null;
    this.onLimit = opts.onLimit || null;
    this._cache = new Map();
  }

  setServer(key) {
    if (!SERVERS[key]) throw new Error("未知服务器：" + key);
    this.serverKey = key;
    this.cfg = SERVERS[key];
    this._cache.clear();
  }

  setToken(t) { this.token = t; }

  /** 构造完整 URL（自动处理 datasource 与缓存破坏参数） */
  buildUrl(path, params) {
    const p = new URLSearchParams();
    if (this.cfg.datasource) p.set("datasource", this.cfg.datasource);
    if (params) {
      for (const k of Object.keys(params)) {
        const v = params[k];
        if (v == null || v === "") continue;
        if (Array.isArray(v)) {
          // 数组用重复参数（实测：逗号分隔会让上游返回 500）
          for (const item of v) p.append(k, String(item));
        } else {
          p.set(k, String(v));
        }
      }
    }
    const q = p.toString();
    return this.cfg.esiBase + path + (q ? "?" + q : "");
  }

  /** 单次请求（返回解析后的 JSON） */
  async request(path, params, opts) {
    opts = opts || {};
    const url = this.buildUrl(path, params);
    const headers = { "User-Agent": UA, "Accept": "application/json" };
    if (opts.auth !== false && this.token) {
      headers.Authorization = "Bearer " + this.token;
    }
    if (opts.body != null) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      headers,
      method: opts.method || "GET",
      body: opts.body != null ? opts.body : undefined,
      signal: AbortSignal.timeout(opts.timeout || 60000)
    });

    // 错误额度监控
    const remain = res.headers.get("x-esi-error-limit-remain");
    const reset = res.headers.get("x-esi-error-limit-reset");
    if (remain != null && this.onLimit) {
      this.onLimit(Number(remain), Number(reset));
    }

    if (res.status === 401) {
      const err = new Error("令牌无效或已过期（401）");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    if (res.status === 429) {
      const err = new Error("触发 ESI 速率限制（429）");
      err.code = "RATE_LIMITED";
      throw err;
    }
    if (res.status === 403) {
      // ★ 403 有两种完全不同的含义，必须区分（实测 2026-11-04）：
      //   a) 令牌本身被拒（格式乱/签名错）→ 响应体是 "authentication failure"
      //   b) 令牌有效，但**该端点需要的 scope 没被授予**→ 也是 "authentication failure"
      //   区分方法：同一个令牌打公开端点（/characters/{id}）能通就是 b。
      //   已知场景：网易官方公共 Client ID 签发的令牌对**所有需 scope 的端点**
      //   一律 403 —— 它的后台只配了极少数 scope，且不包含
      //   esi-skills.read_skills.v1，所以技能/属性/钱包都读不到。
      const body = await res.text().catch(() => "");
      const err = new Error(
        "ESI 拒绝了该请求（403）：**权限不足**。\n" +
        "\n" +
        "这通常不是令牌过期，而是**这个应用没有被授予该接口所需的 scope**。\n" +
        "\n" +
        "若你用的是网易官方公共 Client ID（bc90aa49…），这是**已知限制**：\n" +
        "它在网易后台只配了极少数 scope，不含 esi-skills.read_skills.v1，\n" +
        "所以角色技能、属性、钱包等接口一律 403 —— 但角色公开信息可以正常读取。\n" +
        "\n" +
        "解决办法：\n" +
        "1) **自己注册应用**（推荐）—— 在网易开发者后台为该服注册应用，\n" +
        "   勾选「读取角色技能」权限，用它的 Client ID 走标准授权流程。\n" +
        "2) 或在工具的「角色」页**手动填写技能等级**（数据同样长期保留）。\n" +
        "\n" +
        "原始响应：" + body.slice(0, 120));
      err.code = "SCOPE_DENIED";
      err.status = 403;
      throw err;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error("ESI 请求失败 HTTP " + res.status + " " + body.slice(0, 160));
      err.code = "HTTP_" + res.status;
      throw err;
    }
    const txt = await res.text();
    if (!txt) return null;
    return JSON.parse(txt);
  }

  /**
   * 自动分页请求：读取 X-Pages 头并翻完所有页
   * @param {string} path  以 / 结尾的路径
   * @param {object} params
   */
  async requestAll(path, params, opts) {
    opts = opts || {};
    const maxPages = opts.maxPages || 60;
    let page = 1, pages = 1, out = [];
    do {
      const p = Object.assign({}, params, { page });
      const res = await this.request(path, p, opts);
      const data = this._extractList(res);
      out = out.concat(data);
      pages = res && res.__pages ? res.__pages : pages;
      if (opts.onProgress) opts.onProgress({ page, pages, count: out.length });
      page++;
    } while (page <= pages && page <= maxPages);
    return out;
  }

  /** ESI 部分端点返回 {数据, X-Pages}，此方法归一化为数组 */
  _extractList(res) {
    if (res == null) return [];
    if (Array.isArray(res)) return res;
    if (Array.isArray(res.data)) return res.data;
    if (Array.isArray(res.items)) return res.items;
    return [];
  }

  /* ---------------- 缓存 ---------------- */

  /**
   * 带 TTL 的内存 + 磁盘缓存
   * @param {string} key   缓存键
   * @param {number} ttlMs 有效期
   * @param {Function} producer 生产函数
   */
  async cached(key, ttlMs, producer) {
    const now = Date.now();
    const hit = this._cache.get(key);
    if (hit && now - hit.ts < ttlMs) return hit.value;

    // 磁盘兜底（进程重启后仍可用）
    const dir = path.join(__dirname, "..", "..", "data", "cache");
    const file = path.join(dir, key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) + ".json");
    if (fs.existsSync(file)) {
      try {
        const disk = JSON.parse(fs.readFileSync(file, "utf8"));
        if (now - disk.ts < ttlMs) {
          this._cache.set(key, disk);
          return disk.value;
        }
      } catch (e) { /* 忽略损坏缓存 */ }
    }

    const value = await producer();
    const rec = { ts: now, value };
    this._cache.set(key, rec);
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rec), "utf8");
    } catch (e) { /* 写入失败不影响功能 */ }
    return value;
  }

  /** 清空该服的缓存 */
  clearCache() {
    this._cache.clear();
  }

  /* ---------------- 公开数据快捷方法 ---------------- */

  async getStatus() {
    return this.request(ESI.status, null, { auth: false });
  }

  /** 市场订单（order_type: buy/sell/all） */
  async getMarketOrders(regionId, orderType, typeId) {
    const params = { order_type: orderType };
    if (typeId) params.type_id = typeId;
    return this.request(ESI.marketOrders(regionId), params, { auth: false });
  }

  /** 历史成交（按日聚合） */
  async getMarketHistory(regionId, typeId) {
    return this.request(ESI.marketHistory(regionId), { type_id: typeId }, { auth: false });
  }

  /** 调整后价格 EIV（工业成本基准） */
  async getAdjustedPrices() {
    return this.request(ESI.marketPrices, null, { auth: false });
  }

  /** 公开合同（自动翻页） */
  async getPublicContracts(regionId, opts) {
    return this.requestAll(ESI.publicContracts(regionId), null, Object.assign({ auth: false }, opts));
  }

  /** 宇宙类型（自动翻页，返回 typeID 数组） */
  async getUniverseTypes() {
    return this.requestAll(ESI.universeTypes, null, { auth: false });
  }

  /** 单个类型详情 */
  async getType(typeId) {
    return this.request(ESI.universeType(typeId), null, { auth: false });
  }

  /** 批量 ID 解析（必须 POST + 裸数组） */
  async resolveIds(ids) {
    return this.request(ESI.universeIds, null, {
      auth: false,
      method: "POST",
      body: JSON.stringify(ids)
    });
  }

  /** 工业设施与费率 */
  async getIndustryFacilities() {
    return this.request(ESI.industryFacilities, null, { auth: false });
  }

  /** 各星系工业成本指数 */
  async getIndustrySystems() {
    return this.request(ESI.industrySystems, null, { auth: false });
  }

  /** 保险费 */
  async getInsurancePrices() {
    return this.request(ESI.insurancePrices, null, { auth: false });
  }

  /* ---------------- 认证数据快捷方法 ---------------- */

  /** 角色已训练技能（核心：技能同步） */
  async getSkills(characterId) {
    return this.request(ESI.charSkills(characterId), null, { auth: true });
  }

  /** 技能队列 */
  async getSkillQueue(characterId) {
    return this.request(ESI.charSkillQueue(characterId), null, { auth: true });
  }

  /** 角色属性（智力/记忆/感知） */
  async getAttributes(characterId) {
    return this.request(ESI.charAttributes(characterId), null, { auth: true });
  }

  /** 钱包余额 */
  async getWallet(characterId) {
    return this.request(ESI.charWallet(characterId), null, { auth: true });
  }

  /** 资产清单 */
  async getAssets(characterId) {
    return this.requestAll(ESI.charAssets(characterId), null, { auth: true });
  }

  /** 工业任务 */
  async getIndustryJobs(characterId, includeCompleted) {
    return this.request(ESI.charIndustryJobs(characterId),
      includeCompleted ? { include_completed: true } : null, { auth: true });
  }

  /** 克隆体与植入体 */
  async getClones(characterId) {
    return this.request(ESI.charClones(characterId), null, { auth: true });
  }

  /** 当前位置 */
  async getLocation(characterId) {
    return this.request(ESI.charLocation(characterId), null, { auth: true });
  }

  /** 角色公开信息（免鉴权，可用于校验角色名） */
  async getCharacterPublic(characterId) {
    return this.request(ESI.charPublic(characterId), null, { auth: false });
  }
}

module.exports = { EsiClient, UA };
