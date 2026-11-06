/*
 * EVE 辅助工具 —— 左上角「服务器切换」的纯逻辑
 * Copyright (C) 2026 Junchen-lich
 *
 * 为什么单独成模块：
 *   1. 切换控件必须「打开页面就能点」，不能等 /api/config 回来才渲染；
 *      /api/config 失败时也要能用 —— 所以这里内置三服兜底表。
 *   2. 三服数据完全隔离，切换不只是改一个字符串：要清缓存、换星域、
 *      换税率基准、换角色档案、还要持久化。这些决策全部收在 plan() 里，
 *      便于离线单测覆盖，不必依赖浏览器 DOM。
 *
 * 本文件同时支持浏览器（window.EveServerSwitch）与 Node（require），
 * 不引用任何 DOM / fetch / localStorage 全局，只在调用方传入 storage 时读写。
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.EveServerSwitch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_KEY = "serenity";
  var STORAGE_KEY = "eve_server_v1";

  /* 与 src/core/servers.js 的 SERVER_ORDER / short / label 保持一致。
     仅作首屏兜底，/api/config 返回后以服务端为准。 */
  var FALLBACK_SERVERS = [
    { key: "serenity", label: "国服 经典服（晨曦）", short: "晨曦" },
    { key: "shuguang", label: "国服 曙光服", short: "曙光" },
    { key: "tranquility", label: "欧服（宁静）", short: "欧服" }
  ];

  /** 归一化服务器列表：补齐缺失的 label/short、去重、非空兜底 */
  function normalizeServers(list) {
    var src = (Array.isArray(list) && list.length) ? list : FALLBACK_SERVERS;
    var out = [];
    var seen = {};
    src.forEach(function (s) {
      if (!s || !s.key || seen[s.key]) return;
      var key = String(s.key);
      var fb = null;
      FALLBACK_SERVERS.forEach(function (x) { if (x.key === key) fb = x; });
      out.push({
        key: key,
        label: s.label || (fb && fb.label) || key,
        short: s.short || (fb && fb.short) || s.label || key
      });
      seen[key] = true;
    });
    return out.length ? out : FALLBACK_SERVERS.slice();
  }

  function isKnown(servers, key) {
    var list = normalizeServers(servers);
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return true;
    return false;
  }

  function labelOf(servers, key) {
    var list = normalizeServers(servers);
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].label;
    return key || "";
  }

  function shortOf(servers, key) {
    var list = normalizeServers(servers);
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i].short;
    return key || "";
  }

  /**
   * 各服务器按钮「是否应高亮」的映射。
   * ★ 单独抽成纯函数，是为了让高亮的唯一真相来自 current，
   *   UI 不再自己拼比较表达式 —— 也不会再出现 button.text 那类恒 false 判断。
   */
  function highlightMap(servers, current) {
    var out = {};
    normalizeServers(servers).forEach(function (s) { out[s.key] = (s.key === current); });
    return out;
  }

  /**
   * 决定初始服务器：优先用本地保存值，但必须校验它仍在合法列表里
   * （服务端列表可能随版本变化），否则回落默认值。
   */
  function resolveInitialServer(saved, servers, defaultKey) {
    var list = normalizeServers(servers);
    var def = defaultKey || DEFAULT_KEY;
    if (!isKnown(list, def)) def = list[0].key;
    return isKnown(list, saved) ? saved : def;
  }

  /** localStorage 读写：隐私模式 / 禁用存储时静默降级 */
  function readSaved(storage) {
    try { return storage ? storage.getItem(STORAGE_KEY) : null; }
    catch (e) { return null; }
  }

  function save(storage, key) {
    // 不在这里校验「key 是否属于当前列表」：服务器清单可能随版本增减，
    // 合法性由调用方的 plan() 负责，持久化只负责别写空值。
    try {
      if (!storage || !key || typeof key !== "string") return false;
      storage.setItem(STORAGE_KEY, key);
      return true;
    } catch (e) { return false; }
  }

  /**
   * 切换决策：一次性告诉 UI 需要做什么，避免把逻辑散在 onclick 里。
   *
   * @param {string} current        当前服务器 key
   * @param {string} next           用户点击的 key
   * @param {Array}  servers        合法服务器列表
   * @param {string|null} charServerKey 当前角色所属服（没有角色传 null）
   * @returns {{ok:boolean, changed:boolean, key:string, servers:Array,
   *            clearCaches:boolean, charMismatch:boolean, reason?:string}}
   */
  function plan(current, next, servers, charServerKey) {
    var list = normalizeServers(servers);
    if (!next || !isKnown(list, next)) {
      return { ok: false, changed: false, key: current, servers: list,
        clearCaches: false, charMismatch: false, reason: "unknown" };
    }
    if (next === current) {
      return { ok: true, changed: false, key: current, servers: list,
        clearCaches: false, charMismatch: false };
    }
    return {
      ok: true,
      changed: true,
      key: next,
      servers: list,
      /* 三服数据不可混用：行情/计算结果缓存必须清掉 */
      clearCaches: true,
      /* 角色属于别的服 → 技能、声望读数都不能沿用 */
      charMismatch: !!charServerKey && charServerKey !== next
    };
  }

  return {
    DEFAULT_KEY: DEFAULT_KEY,
    STORAGE_KEY: STORAGE_KEY,
    FALLBACK_SERVERS: FALLBACK_SERVERS,
    normalizeServers: normalizeServers,
    isKnown: isKnown,
    labelOf: labelOf,
    shortOf: shortOf,
    highlightMap: highlightMap,
    resolveInitialServer: resolveInitialServer,
    readSaved: readSaved,
    save: save,
    plan: plan
  };
});
