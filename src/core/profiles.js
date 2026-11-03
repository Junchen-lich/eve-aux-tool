/*
 * EVE 辅助工具 —— 角色档案
 * Copyright (C) 2026 Junchen-lich
 *
 * 职责：
 *   1. 管理多角色档案（角色 ID + 服务器为主键）
 *   2. 从 ESI 拉取并缓存角色数据（技能、属性、钱包、资产、工业任务）
 *   3. 技能同步：把 ESI 技能响应转换为「内部 id → 等级」
 *   4. 技能变化检测：提示用户「某技能升级导致税率/产出变化」
 *
 * ★ 命名分离：内部一律用英文 id（skill-map 的 id），前台展示用中文名
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { EsiClient } = require("./esi-client.js");
const skillMap = require("./skill-map.js");
const { SERVERS } = require("./servers.js");

const ROOT = path.join(__dirname, "..", "..");
const PROFILE_DIR = path.join(ROOT, "用户数据");
const PROFILE_FILE = path.join(PROFILE_DIR, "eve_char_profiles_v1.json");

/** 角色档案结构
 * {
 *   id: "serenity:12345",
 *   serverKey: "serenity",
 *   characterId: 12345,
 *   characterName: "Pilot Name",
 *   skills: { ind: 5, acct: 3, ... },      // 内部 id → 等级
 *   attributes: { intelligence, memory, perception },
 *   wallet: { balance },
 *   assets: { count, summary },
 *   industryJobs: { active, completed },
 *   location: { systemId, systemName },
 *   online: bool,
 *   syncedAt: timestamp,
 *   skillSnapshot: { ... }                 // 上次同步的技能，用于变化检测
 * }
 */
class ProfileStore {
  constructor() {
    this.profiles = this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(PROFILE_FILE)) return {};
      const raw = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch (e) {
      return {};
    }
  }

  _save() {
    try {
      if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
      fs.writeFileSync(PROFILE_FILE, JSON.stringify(this.profiles, null, 2), "utf8");
    } catch (e) { /* 持久化失败不影响本次会话 */ }
  }

  static key(serverKey, characterId) {
    return serverKey + ":" + characterId;
  }

  /** 取档案 */
  get(serverKey, characterId) {
    return this.profiles[ProfileStore.key(serverKey, characterId)] || null;
  }

  /** 全部档案（按服务器分组，前台用） */
  list() {
    const out = [];
    for (const [key, p] of Object.entries(this.profiles)) {
      out.push({
        key,
        id: p.characterId,
        serverKey: p.serverKey,
        serverLabel: SERVERS[p.serverKey] ? SERVERS[p.serverKey].label : p.serverKey,
        // 前台显示中文名
        characterName: p.characterName || ("角色 " + p.characterId),
        skillCount: Object.keys(p.skills || {}).length,
        totalSP: p.totalSP || 0,
        syncedAt: p.syncedAt || null,
        expired: !!(p.tokenExpired)
      });
    }
    return out;
  }

  /** 保存档案 */
  save(profile) {
    const key = profile.key || ProfileStore.key(profile.serverKey, profile.characterId);
    this.profiles[key] = Object.assign({}, this.profiles[key], profile, { key });
    this._save();
    return this.profiles[key];
  }

  /** 删除档案 */
  remove(key) {
    if (this.profiles[key]) {
      delete this.profiles[key];
      this._save();
      return true;
    }
    return false;
  }

  /**
   * 检测技能变化
   * @returns {Array} [{ id, nameZh, from, to, effect }]
   */
  detectSkillChanges(profile) {
    const old = profile.skillSnapshot || {};
    const cur = profile.skills || {};
    const changes = [];
    for (const id of Object.keys(cur)) {
      const from = old[id];
      const to = cur[id];
      if (from === undefined) continue;
      if (from !== to) {
        const def = skillMap.byId(id);
        changes.push({
          id,
          nameZh: def ? def.nameZh : id,
          from,
          to,
          effect: def ? def.effect : ""
        });
      }
    }
    return changes;
  }

  /**
   * 全量同步一个角色的数据
   * @param {object} p
   *  serverKey, characterId, accessToken, onStatus
   */
  async sync(p) {
    const client = new EsiClient({
      server: p.serverKey,
      token: p.accessToken,
      onLimit: p.onLimit
    });

    const onStatus = p.onStatus || (() => { });
    onStatus("拉取技能…");
    const skillsResp = await client.getSkills(p.characterId);
    const parsed = skillMap.parseEsiSkills(skillsResp);

    onStatus("拉取角色属性…");
    let attributes = null;
    try { attributes = await client.getAttributes(p.characterId); } catch (e) { /* 可选 */ }

    onStatus("拉取钱包…");
    let wallet = null;
    try { wallet = await client.getWallet(p.characterId); } catch (e) { /* 可选 */ }

    onStatus("拉取资产…");
    let assets = null;
    try {
      const arr = await client.getAssets(p.characterId);
      assets = { count: arr.length };
    } catch (e) { /* 可选 */ }

    onStatus("拉取工业任务…");
    let jobs = null;
    try {
      const arr = await client.getIndustryJobs(p.characterId, true);
      jobs = {
        total: arr.length,
        active: arr.filter(j => j.status === "active" || j.status === "running").length
      };
    } catch (e) { /* 可选 */ }

    onStatus("拉取角色位置…");
    let location = null, online = null;
    try {
      const loc = await client.getLocation(p.characterId);
      location = { systemId: loc.system_id, structureId: loc.structure_id };
    } catch (e) { /* 可选 */ }
    try {
      online = await client.getOnline(p.characterId);
    } catch (e) { /* 可选 */ }

    // 角色名（公开接口，免鉴权）
    let characterName = null;
    try {
      const pub = await client.getCharacterPublic(p.characterId);
      characterName = pub.name;
    } catch (e) { /* 可选 */ }

    // 技能快照用于变化检测
    const prev = this.get(p.serverKey, p.characterId);
    const profile = {
      serverKey: p.serverKey,
      characterId: p.characterId,
      characterName,
      skills: parsed.levels,
      skillSnapshot: prev ? prev.skills : Object.assign({}, parsed.levels),
      unmatchedSkills: parsed.unmatched,
      totalSP: skillsResp && skillsResp.total_sp ? skillsResp.total_sp : 0,
      attributes: attributes ? {
        intelligence: attributes.intelligence,
        memory: attributes.memory,
        perception: attributes.perception
      } : null,
      wallet: wallet ? { balance: wallet.balance } : null,
      assets,
      industryJobs: jobs,
      location,
      online,
      syncedAt: Date.now()
    };

    const saved = this.save(profile);
    const changes = this.detectSkillChanges(saved);
    saved.skillChanges = changes;
    this._save();
    return saved;
  }

  /**
   * 前台展示：技能列表（中文名 + 等级 + 效果说明）
   * @param {object} profile
   */
  displaySkills(profile) {
    const skills = (profile && profile.skills) || {};
    return skillMap.displayList().map(s => ({
      id: s.id,
      name: s.name,          // 中文名（前台）
      nameEn: s.nameEn,      // 英文名（保留供导出与排查）
      effect: s.effect,
      group: s.group,
      level: skills[s.id] || 0,
      hasSkill: (skills[s.id] || 0) > 0
    }));
  }

  /**
   * 前台展示：技能分组视图
   */
  displaySkillGroups(profile) {
    const skills = (profile && profile.skills) || {};
    const groups = skillMap.displayGroups();
    const out = {};
    for (const [gname, list] of Object.entries(groups)) {
      out[gname] = list.map(s => ({
        id: s.id,
        name: s.name,
        effect: s.effect,
        level: skills[s.id] || 0
      }));
    }
    return out;
  }
}

module.exports = { ProfileStore, PROFILE_FILE, PROFILE_DIR };
