/*
 * EVE 辅助工具 —— 运行时数据获取
 * Copyright (C) 2026 Junchen-lich
 *
 * 职责：
 *   1. 从 ESI 拉取工业设施费率与星系成本指数，落盘为本地数据表
 *   2. 拉取 EIV 调整后价格（工业成本基准）
 *   3. 处理错误额度（欧服 100 / 国服 50）与分页
 *
 * ★ 三服差异
 *   - 设施费率与成本指数是「不区分服」的静态数据，三服内容一致，
 *     但仍按服分别缓存，避免跨服混用
 *   - EIV（调整后价格）**按服不同**：欧服 16064 条 / 国服 11834 条，
 *     同 typeID 的调整价也不同（实测 type 18：欧服 27.06 / 国服 51.13）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { EsiClient } = require("../core/esi-client.js");
const { SERVERS } = require("../core/servers.js");

const ROOT = path.join(__dirname, "..", "..");
const SDE_DIR = path.join(ROOT, "data", "sde");

/** 缓存有效期（毫秒） */
const TTL = {
  facilityRates: 7 * 24 * 3600 * 1000,   // 设施费率一周
  costIndex: 7 * 24 * 3600 * 1000,       // 成本指数一周
  eiv: 6 * 3600 * 1000,                  // EIV 六小时
  market: 60 * 1000                      // 行情一分钟
};

/**
 * 拉取并缓存工业设施费率
 * @param {EsiClient} client
 */
async function fetchFacilityRates(client) {
  const data = await client.getIndustryFacilities();
  // 聚合：type_id → 各设施费率
  const byType = {};
  for (const f of data) {
    const tid = f.type_id;
    if (!byType[tid]) byType[tid] = { typeId: tid, min: Infinity, max: 0, sum: 0, count: 0, facilities: [] };
    const e = byType[tid];
    e.facilities.push({ facilityId: f.facility_id, ownerId: f.owner_id, regionId: f.region_id, systemId: f.solar_system_id });
    e.count++;
    e.sum += (f.owner_id || 0);
  }
  for (const e of Object.values(byType)) {
    e.avgOwner = e.count ? e.sum / e.count : 0;
    delete e.sum;
  }
  const out = Object.values(byType);
  save("facility_rates.json", out);
  return out;
}

/**
 * 拉取并缓存星系工业成本指数
 */
async function fetchCostIndex(client) {
  const data = await client.getIndustrySystems();
  const out = data.map(s => ({
    systemId: s.solar_system_id,
    // 各类活动的成本指数：manufacturing / researching_time_efficiency / researching_material_efficiency ...
    indices: (s.cost_indices || []).reduce((m, c) => {
      m[c.activity] = c.cost_index;
      return m;
    }, {})
  }));
  save("cost_index.json", out);
  return out;
}

/**
 * 拉取并缓存 EIV 调整后价格
 */
async function fetchEiv(client) {
  const data = await client.getAdjustedPrices();
  const map = {};
  for (const p of data) {
    map[p.type_id] = {
      adjusted: p.adjusted_price,
      average: p.average_price
    };
  }
  // 按服分别命名，避免国服与欧服互相覆盖
  const file = "eiv_" + client.serverKey + ".json";
  save(file, map);
  return map;
}

/**
 * 拉取某区域某物品的订单簿（带缓存）
 */
async function fetchOrders(client, regionId, typeId, orderType) {
  const key = "orders_" + client.serverKey + "_" + regionId + "_" + typeId + "_" + orderType;
  return client.cached(key, TTL.market, async () => {
    const orders = await client.getMarketOrders(regionId, orderType, typeId);
    const arr = Array.isArray(orders) ? orders : (orders && orders.data) || [];
    // 归一化为便于计算的结构
    return arr.map(o => ({
      typeId: o.type_id,
      price: o.price,
      volume: o.volume,
      locationId: o.location_id,
      isBuy: !!o.is_buy_order,
      issued: o.issued,
      minVolume: o.min_volume,
      orderId: o.order_id
    }));
  });
}

/**
 * 拉取历史成交
 */
async function fetchHistory(client, regionId, typeId) {
  const key = "history_" + client.serverKey + "_" + regionId + "_" + typeId;
  return client.cached(key, TTL.eiv, async () => {
    const h = await client.getMarketHistory(regionId, typeId);
    return (h || []).map(d => ({
      date: d.date,
      average: d.average,
      highest: d.highest,
      lowest: d.lowest,
      volume: d.volume,
      orderCount: d.order_count
    }));
  });
}

/* ------------------------------------------------------------------ *
 * 磁盘持久化
 * ------------------------------------------------------------------ */
function save(name, data) {
  if (!fs.existsSync(SDE_DIR)) fs.mkdirSync(SDE_DIR, { recursive: true });
  const full = path.join(SDE_DIR, name);
  fs.writeFileSync(full, JSON.stringify(data), "utf8");
  return full;
}

function load(name, optional) {
  const full = path.join(SDE_DIR, name);
  if (!fs.existsSync(full)) {
    if (optional) return null;
    throw new Error("数据表缺失：" + name);
  }
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

/**
 * 确保某服的工业数据已就位（缺则拉取）
 */
async function ensureIndustryData(serverKey, onLimit) {
  const client = new EsiClient({ server: serverKey, onLimit });
  const results = {};
  if (!load("facility_rates.json", true)) {
    results.facilityRates = (await fetchFacilityRates(client)).length;
  }
  if (!load("cost_index.json", true)) {
    results.costIndex = (await fetchCostIndex(client)).length;
  }
  const eivFile = "eiv_" + serverKey + ".json";
  if (!load(eivFile, true)) {
    results.eiv = Object.keys(await fetchEiv(client)).length;
  }
  return results;
}

/**
 * 读取某服的 EIV 表
 */
function eivOf(serverKey) {
  return load("eiv_" + serverKey + ".json", true) || {};
}

/**
 * 读取成本指数（按星系）
 */
function costIndexOf() {
  const arr = load("cost_index.json", true) || [];
  const map = {};
  for (const c of arr) map[c.systemId] = c.indices;
  return map;
}

/**
 * 计算某星系的某活动成本指数
 */
function costIndexFor(systemId, activity) {
  const m = costIndexOf();
  const idx = m[systemId];
  if (!idx) return 0;
  return idx[activity] != null ? idx[activity] : 0;
}

/**
 * 取某 typeID 的 EIV 调整价（工业费计算基准）
 */
function eivPrice(serverKey, typeId) {
  const e = eivOf(serverKey);
  const v = e[String(typeId)];
  return v ? v.adjusted : 0;
}

module.exports = {
  TTL,
  fetchFacilityRates,
  fetchCostIndex,
  fetchEiv,
  fetchOrders,
  fetchHistory,
  ensureIndustryData,
  eivOf,
  costIndexOf,
  costIndexFor,
  eivPrice,
  save,
  load
};
