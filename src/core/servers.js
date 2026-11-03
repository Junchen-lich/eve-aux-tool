/*
 * EVE 辅助工具 —— 服务器配置与端点定义
 * Copyright (C) 2026 Junchen-lich
 *
 * 三套彼此隔离的服务器集群，数据不可混用：
 *   欧服（宁静）tranquility —— CCP Games
 *   国服经典服（晨曦）serenity —— 网易
 *   国服曙光服 shuguang —— 网易（与晨曦同集群，同域名）
 *
 * 所有端点均于 2026-11-03 实测验证。
 */
"use strict";

const SERVERS = {
  tranquility: {
    key: "tranquility",
    label: "欧服（宁静）",
    short: "欧服",
    // CCP 官方 ESI
    esiBase: "https://esi.evetech.net/latest",
    // 欧服 datasource 必须显式指定
    datasource: "tranquility",
    // EVE SSO 授权与令牌端点
    // ★ 欧服用 GET /v2/oauth/authorize/（浏览器直接跳转）
    ssoAuthorize: "https://login.eveonline.com/v2/oauth/authorize/",
    ssoToken: "https://login.eveonline.com/v2/oauth/token/",
    ssoAuthorizeMethod: "GET",
    // 欧服 scope 无数量上限（但官方不建议全要）
    maxScopes: 0,
    ssoExtraParams: {},
    // 第三方补充源
    c3qBase: "https://eve.c3q.cc/market/api/",
    cevePrefix: "/tqapi",
    // 错误额度（实测 X-Esi-Error-Limit-Remain）
    errorBudget: 100
  },

  serenity: {
    key: "serenity",
    label: "国服 经典服（晨曦）",
    short: "晨曦",
    // 网易官方 ESI —— 与欧服接口结构基本一致，但不接受 datasource 参数
    esiBase: "https://ali-esi.evepc.163.com/latest",
    datasource: null,
    // 国服 SSO
    ssoAuthorize: "https://login.evepc.163.com/v2/oauth/authorize/",
    ssoToken: "https://login.evepc.163.com/v2/oauth/token/",
    // ★ 实测（2026-11-03，浏览器实地验证）：国服 authorize 用 GET 跳转**完全可行**，
    //   会正常重定向到网易账号登录页。此前用 curl 探测得出「只支持 POST」是误判 ——
    //   原因是 curl 请求缺少 client_id/scope/realm 等参数，被服务端拒绝。
    //   保留 POST 作为兜底（服务端表单转发），但默认走 GET 直跳。
    ssoAuthorizeMethod: "GET",
    // 国服额外必填参数（realm / device_id 任意值即可）
    ssoExtraParams: { realm: "esi", device_id: "eve-aux-tool" },
    // 国服 scope 一次最多 4 项
    maxScopes: 4,
    c3qBase: "https://cn.c3q.cc:20080/eve/market/api/",
    cevePrefix: "/api",
    errorBudget: 50,
    marketSource: "esi",
    esiMarketIsShared: false
  },

  shuguang: {
    key: "shuguang",
    label: "国服 曙光服",
    short: "曙光",
    // 网易官方 ESI（晨曦与曙光同集群同域名）
    esiBase: "https://ali-esi.evepc.163.com/latest",
    datasource: null,
    ssoAuthorize: "https://login.evepc.163.com/v2/oauth/authorize/",
    ssoToken: "https://login.evepc.163.com/v2/oauth/token/",
    // ★ 实测（2026-11-03，浏览器实地验证）：国服 authorize 用 GET 跳转**完全可行**，
    //   会正常重定向到网易账号登录页。此前用 curl 探测得出「只支持 POST」是误判 ——
    //   原因是 curl 请求缺少 client_id/scope/realm 等参数，被服务端拒绝。
    //   保留 POST 作为兜底（服务端表单转发），但默认走 GET 直跳。
    ssoAuthorizeMethod: "GET",
    // 国服额外必填参数（realm / device_id 任意值即可）
    ssoExtraParams: { realm: "esi", device_id: "eve-aux-tool" },
    // 国服 scope 一次最多 4 项
    maxScopes: 4,
    c3qBase: "https://cn.c3q.cc:20080/eve/market-sg/api/",
    cevePrefix: "/infapi",
    errorBudget: 50,
    // ⚠️ 实测重要约束（2026-11-03）：
    // 晨曦与曙光共用同一 ESI 域名与集群，ESI 返回的市场/合同数据
    // 在两服间**完全相同**（实测三钛合金订单均为 35 条、价 10.18）。
    // 因此曙光服的真实市场数据必须走 c3q 的 market-sg 路径，
    // ESI 只能用于「不区分服」的静态数据（宇宙、类型、EIV 基准等）。
    marketSource: "c3q",
    esiMarketIsShared: true
  }
};

const SERVER_ORDER = ["serenity", "shuguang", "tranquility"];

/* ------------------------------------------------------------------ *
 * ESI 端点路径（欧服与国服通用，实测归一化后端点集合仅差 2 个 meta）
 * ------------------------------------------------------------------ */
const ESI = {
  status: "/status/",
  // 市场
  marketOrders: (regionId) => `/markets/${regionId}/orders/`,
  marketHistory: (regionId) => `/markets/${regionId}/history/`,
  marketTypes: (regionId) => `/markets/${regionId}/types/`,
  marketPrices: "/markets/prices/",
  marketGroups: "/markets/groups/",
  // 合同
  publicContracts: (regionId) => `/contracts/public/${regionId}/`,
  publicContractItems: (contractId) => `/contracts/public/items/${contractId}/`,
  publicContractBids: (contractId) => `/contracts/public/bids/${contractId}/`,
  // 角色（需鉴权）
  charSkills: (charId) => `/characters/${charId}/skills/`,
  charSkillQueue: (charId) => `/characters/${charId}/skillqueue/`,
  charAttributes: (charId) => `/characters/${charId}/attributes/`,
  charPublic: (charId) => `/characters/${charId}/`,
  charPortrait: (charId) => `/characters/${charId}/portrait/`,
  charCorpHistory: (charId) => `/characters/${charId}/corporationhistory/`,
  charWallet: (charId) => `/characters/${charId}/wallet/`,
  charWalletJournal: (charId) => `/characters/${charId}/wallet/journal/`,
  charAssets: (charId) => `/characters/${charId}/assets/`,
  charAssetLocations: (charId) => `/characters/${charId}/assets/locations/`,
  charAssetNames: (charId) => `/characters/${charId}/assets/names/`,
  charIndustryJobs: (charId) => `/characters/${charId}/industry/jobs/`,
  charMining: (charId) => `/characters/${charId}/mining/`,
  charPlanets: (charId) => `/characters/${charId}/planets/`,
  charClones: (charId) => `/characters/${charId}/clones/`,
  charImplants: (charId) => `/characters/${charId}/implants/`,
  charLocation: (charId) => `/characters/${charId}/location/`,
  charShip: (charId) => `/characters/${charId}/ship/`,
  charOnline: (charId) => `/characters/${charId}/online/`,
  charOrders: (charId) => `/characters/${charId}/orders/`,
  charContracts: (charId) => `/characters/${charId}/contracts/`,
  charStandings: (charId) => `/characters/${charId}/standings/`,
  charLoyalty: (charId) => `/characters/${charId}/loyalty/points/`,
  charNotifications: (charId) => `/characters/${charId}/notifications/`,
  charRoles: (charId) => `/characters/${charId}/roles/`,
  charFittings: (charId) => `/characters/${charId}/fittings/`,
  charBookmarks: (charId) => `/characters/${charId}/bookmarks/`,
  charOpportunities: (charId) => `/characters/${charId}/opportunities/`,
  // 宇宙
  universeTypes: "/universe/types/",
  universeType: (typeId) => `/universe/types/${typeId}/`,
  universeIds: "/universe/ids/",
  universeNames: "/universe/names/",
  universeSystems: "/universe/systems/",
  universeSystem: (id) => `/universe/systems/${id}/`,
  universeRegions: "/universe/regions/",
  universeConstellations: "/universe/constellations/",
  universeStations: (id) => `/universe/stations/${id}/`,
  universeStructures: "/universe/structures/",
  universeGroups: "/universe/groups/",
  universeCategories: "/universe/categories/",
  universeFactions: "/universe/factions/",
  // 工业
  industryFacilities: "/industry/facilities/",
  industrySystems: "/industry/systems/",
  // 其他
  insurancePrices: "/insurance/prices/",
  route: (from, to) => `/route/${from}/${to}/`,
  search: "/search/",
  dogmataAttributes: "/dogma/attributes/",
  dogmataEffects: "/dogma/effects/"
};

/* ------------------------------------------------------------------ *
 * 所需 scope（按功能分组）
 * 国服 scope 命名与欧服一致（国服 66 个 / 欧服 72 个）
 * 国服独有：bookmarks ×2、characters.read_opportunities
 * 欧服独有：structures.read_*、freelance_jobs、projects 等
 * ------------------------------------------------------------------ */
const SCOPES = {
  // 技能同步（核心功能）
  skills: ["esi-skills.read_skills.v1", "esi-skills.read_skillqueue.v1"],
  // 角色状态
  attributes: ["esi-characters.read_character.v1"],
  location: ["esi-location.read_location.v1", "esi-location.read_online.v1", "esi-location.read_ship_type.v1"],
  // 财务
  wallet: ["esi-wallet.read_character_wallet.v1"],
  // 资产
  assets: ["esi-assets.read_assets.v1"],
  // 工业
  industry: ["esi-industry.read_character_jobs.v1", "esi-industry.read_character_mining.v1"],
  // 行星工业
  planets: ["esi-planets.read_planets.v1", "esi-planets.manage_planets.v1"],
  // 克隆体与植入体
  clones: ["esi-clones.read_clones.v1", "esi-clones.read_implants.v1"],
  // 市场（角色挂单）
  marketOrders: ["esi-markets.read_character_orders.v1"],
  // 合同
  contracts: ["esi-contracts.read_character_contracts.v1"],
  // 其他
  standings: ["esi-characters.read_standings.v1"],
  loyalty: ["esi-characters.read_loyalty.v1"],
  fittings: ["esi-fittings.read_fittings.v1"],
  notifications: ["esi-characters.read_notifications.v1"]
};

/* 最小可用 scope 集：仅够完成「拉角色数据 + 同步技能参数 + 收益计算」 */
const SCOPES_MINIMAL = [
  "esi-skills.read_skills.v1",
  "esi-skills.read_skillqueue.v1",
  "esi-wallet.read_character_wallet.v1",
  "esi-assets.read_assets.v1",
  "esi-industry.read_character_jobs.v1",
  "esi-characters.read_standings.v1"
];

/* c3q 合同接口服务名（国服有 buyout 字段，补 ESI 缺失） */
const C3Q_SERVICES = {
  buyAssess: "queryBuyAssess",
  sellAssess: "querySellAssess",
  listBuyOrder: "listBuyOrder",
  listSellOrder: "listSellOrder",
  contractAll: "listContractAll"
};

module.exports = { SERVERS, SERVER_ORDER, ESI, SCOPES, SCOPES_MINIMAL, C3Q_SERVICES };
