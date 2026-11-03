/*
 * EVE 辅助工具 —— 数据加载层
 * Copyright (C) 2026 Junchen-lich
 *
 * 职责：
 *   1. 加载本地静态数据库（SDE 固化 + 人工维护表）
 *   2. 提供「后台英文名 / 前台中文名」的双向映射
 *   3. 运行时缓存（带 TTL），减少上游请求
 *
 * ★ 命名分离原则（贯穿全项目）
 *   后台内部一律使用**英文名**与 typeID 作为主键（跨服稳定、可与 SDE/ESI 对齐）；
 *   前台展示一律使用**中文名**。
 *   两者通过 skill-map.js 的桥接表连接。
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data");
const SDE_DIR = path.join(DATA_DIR, "sde");
const CACHE_DIR = path.join(DATA_DIR, "cache");

/** 本地静态库清单 */
const DB_FILES = {
  blueprints: "blueprints.json",
  industry: "industry.json",
  itemNames: "item_names.json",
  itemNamesEn: "item_names_en.json",
  universe: "universe.json",
  marketGroups: "market_groups.json",
  piSchematics: "pi_schematics.json",
  oreRefine: "ore_refine.json",
  stations: "stations.json",
  structures: "structures.json",
  skills: "skills_zh.json",
  taxConfig: "tax_config.json",
  facilityRates: "facility_rates.json",
  costIndex: "cost_index.json"
};

class DataStore {
  constructor() {
    this._cache = new Map();   // 内存缓存
    this._raw = new Map();     // 解析后的静态库
    this._meta = new Map();
  }

  /* ---------------- 静态库 ---------------- */

  /**
   * 读取并解析一个静态 JSON 库
   * @param {string} key DB_FILES 的键
   * @param {boolean} optional 缺失时返回 null 而非抛错
   */
  load(key, optional) {
    if (this._raw.has(key)) return this._raw.get(key);
    const file = DB_FILES[key];
    if (!file) throw new Error("未知数据表：" + key);
    const full = path.join(SDE_DIR, file);
    if (!fs.existsSync(full)) {
      if (optional) return null;
      throw new Error("数据表缺失：" + file + "（请先运行构建脚本）");
    }
    const data = JSON.parse(fs.readFileSync(full, "utf8"));
    this._raw.set(key, data);
    return data;
  }

  /** 物品中文名表：{ typeID: 中文名 } */
  itemNames() { return this.load("itemNames", true) || {}; }

  /** 物品英文名表：{ typeID: EnglishName } —— 后台匹配用 */
  itemNamesEn() { return this.load("itemNamesEn", true) || {}; }

  /** 蓝图数据 */
  blueprints() { return this.load("blueprints"); }

  /** 工业活动数据 { times, mats, prods } */
  industry() { return this.load("industry"); }

  /** 宇宙数据 { regions, constellations, systems } */
  universe() { return this.load("universe"); }

  /** 市场分组树 */
  marketGroups() { return this.load("marketGroups"); }

  /** 行星工业配方 */
  piSchematics() { return this.load("piSchematics", true) || {}; }

  /** 矿石分级与精炼产物 */
  oreRefine() { return this.load("oreRefine", true) || {}; }

  /** NPC 空间站 */
  stations() { return this.load("stations", true) || { stations: [] }; }

  /** 玩家公开建筑 */
  structures() { return this.load("structures", true) || { structures: [] }; }

  /** 人工维护的技能效果表 */
  skillsConfig() { return this.load("skills", true) || {}; }

  /** 人工维护的税率配置 */
  taxConfig() { return this.load("taxConfig", true) || {}; }

  /** 设施费率 */
  facilityRates() { return this.load("facilityRates", true) || []; }

  /** 星系成本指数 */
  costIndex() { return this.load("costIndex", true) || []; }

  /* ---------------- 名称解析（后台） ---------------- */

  /**
   * typeID → 英文名（后台主键路径）
   */
  englishName(typeId) {
    const en = this.itemNamesEn();
    return en[String(typeId)] || null;
  }

  /**
   * 英文名 → typeID（后台主键路径）
   */
  typeIdByEnglishName(name) {
    if (!name) return null;
    const target = String(name).trim().toLowerCase();
    const en = this.itemNamesEn();
    for (const id of Object.keys(en)) {
      if (en[id].toLowerCase() === target) return Number(id);
    }
    return null;
  }

  /**
   * typeID → 中文名（前台显示）
   */
  chineseName(typeId) {
    const zh = this.itemNames();
    return zh[String(typeId)] || null;
  }

  /**
   * 解析类型（后台用英文，前台用中文）
   *
   * ★ 显示回退链（前台永不显示空白，也绝不暴露 typeID）：
   *     中文名 → 英文名 → 「未收录物品」
   *   实测缺口：蓝图涉及的 10494 个 typeID 中，1517 个（14.5%）在官方包
   *   的中文名表里没有；其中 441 个有英文名可回退，1076 个（SDE 独有条目，
   *   如 Clone Grade Beta Blueprint）两个表都没有。
   *
   * @returns {{ typeId, nameEn, nameZh, display, hasZh }}
   */
  resolve(typeId) {
    const id = Number(typeId);
    const nameEn = this.englishName(id);
    const nameZh = this.chineseName(id);
    return {
      typeId: id,
      nameEn: nameEn || null,
      nameZh: nameZh || null,
      hasZh: !!nameZh,
      // 前台优先中文，缺失时退回英文，最后兜底
      display: nameZh || nameEn || "未收录物品"
    };
  }

  /**
   * 批量解析（前台用）：返回 { typeId: {name, en, zh} } 映射
   */
  resolveMany(typeIds) {
    const out = {};
    for (const t of typeIds) out[String(t)] = this.resolve(t);
    return out;
  }

  /* ---------------- 运行时缓存 ---------------- */

  /**
   * 带 TTL 的文件缓存
   * @param {string} key  缓存键
   * @param {number} ttlMs 有效期
   * @param {Function} producer 生产函数（异步）
   */
  async cached(key, ttlMs, producer) {
    const hit = this._cache.get(key);
    const now = Date.now();
    if (hit && now - hit.ts < ttlMs) return hit.value;

    const file = path.join(CACHE_DIR, safeName(key) + ".json");
    // 磁盘缓存兜底（进程重启后仍可用）
    if (fs.existsSync(file)) {
      try {
        const disk = JSON.parse(fs.readFileSync(file, "utf8"));
        if (now - disk.ts < ttlMs) {
          this._cache.set(key, disk);
          return disk.value;
        }
      } catch (e) { /* 忽略损坏的缓存 */ }
    }

    const value = await producer();
    const rec = { ts: now, value };
    this._cache.set(key, rec);
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(rec), "utf8");
    } catch (e) { /* 缓存写入失败不影响功能 */ }
    return value;
  }

  clearCache() {
    this._cache.clear();
    try {
      if (fs.existsSync(CACHE_DIR)) {
        for (const f of fs.readdirSync(CACHE_DIR)) {
          fs.unlinkSync(path.join(CACHE_DIR, f));
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  /** 数据表清单与体积（用于设置页展示） */
  stats() {
    const out = [];
    for (const key of Object.keys(DB_FILES)) {
      const full = path.join(SDE_DIR, DB_FILES[key]);
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      let count = null;
      try {
        const d = JSON.parse(fs.readFileSync(full, "utf8"));
        count = Array.isArray(d) ? d.length : Object.keys(d).length;
      } catch (e) { /* 忽略 */ }
      out.push({ key, file: DB_FILES[key], bytes: st.size, count });
    }
    return out;
  }
}

/** 缓存键安全化 */
function safeName(key) {
  return String(key).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

/** 单例 */
const store = new DataStore();

module.exports = { DataStore, store, DB_FILES, DATA_DIR, SDE_DIR, CACHE_DIR };
