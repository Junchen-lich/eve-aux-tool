"use strict";

/* ------------------------------------------------------------------ *
 * 空间站查询与站主势力映射
 *
 * ★ 为什么需要这个模块
 *   中介费的官方公式含两项声望修正：
 *     3% − 0.3%×经纪人关系学 − 0.03%×势力声望 − 0.02%×军团声望
 *   而「势力声望」与「军团声望」都是**相对于挂单所在空间站的站主**而言的：
 *     势力声望 = 与「站主所属势力」的声望
 *     军团声望 = 与「站主军团」的声望
 *   所以要知道该填哪个声望，必须先知道在哪个站挂单。
 *
 * ★ 数据来源与实测结论（2026-11-04）
 *   - ESI /universe/stations/{id}/ 在国服与欧服均可用，返回 owner（站主 corp id），
 *     但**均不返回 faction_id**。
 *   - ESI /universe/factions/ 只含 29 个主力势力（500xxx），
 *     NPC corps（1000xxx，如 InterBus 星捷运）不在其中 → 无法由 owner 直接反查势力。
 *   - ESI /corporations/{id}/ 在国服可用，但同样**无 faction_id**；
 *     批量请求会被限流封禁（实测 176 次请求全失败）。
 *   → 因此势力归属用「站名公司名 → 已知 NPC corp 势力映射表」反推。
 *     映射表的中英对照来自 EVE 官方 NPC 军团译名表；
 *     势力归属按四大势力（加达里/盖伦特/艾玛/米玛塔尔）归类。
 * ------------------------------------------------------------------ */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const STATIONS_FILE = path.join(ROOT, "data", "sde", "stations.json");

/* ------------------------------------------------------------------ *
 * 势力定义
 * ------------------------------------------------------------------ */
const FACTION_CAL = 500001;   // 加达里联邦 Caldari State
const FACTION_GAL = 500004;   // 盖伦特联邦 Gallente Federation
const FACTION_AMR = 500003;   // 艾玛帝国 Amarr Empire
const FACTION_MIN = 500002;   // 米玛塔尔共和国 Minmatar Republic

/** 势力清单（供界面下拉选择） */
const FACTIONS = [
  { factionId: FACTION_CAL, nameEn: "Caldari State", nameZh: "加达里联邦" },
  { factionId: FACTION_MIN, nameEn: "Minmatar Republic", nameZh: "米玛塔尔共和国" },
  { factionId: FACTION_AMR, nameEn: "Amarr Empire", nameZh: "艾玛帝国" },
  { factionId: FACTION_GAL, nameEn: "Gallente Federation", nameZh: "盖伦特联邦" }
];

/* ------------------------------------------------------------------ *
 * 公司名 → 势力
 *
 * ★ 键为国服中文站名里出现的公司名前缀（不含设施名）。
 *   势力按四大势力归类；中立组织单列（factionId 为 null → 需用户手填）。
 * ------------------------------------------------------------------ */
const CORP_FACTION = {
  /* ============ 加达里联邦 Caldari State ============ */
  "CBD社团": FACTION_CAL,
  "CBD销售部": FACTION_CAL,
  "CEO合作组织": FACTION_CAL,
  "加达里后勤部": FACTION_CAL,
  "加达里商业": FACTION_CAL,
  "加达里商业法庭": FACTION_CAL,
  "加达里建筑集团": FACTION_CAL,
  "加达里无限基金集团": FACTION_CAL,
  "加达里海军": FACTION_CAL,
  "加达里钢铁集团": FACTION_CAL,
  "卡拉吉塔集团": FACTION_CAL,
  "维克米集团": FACTION_CAL,
  "维克米和平工业": FACTION_CAL,
  "异株湖集团": FACTION_CAL,
  "异株湖安全部队": FACTION_CAL,
  "家庭保安公司": FACTION_CAL,
  "行家物流公司": FACTION_CAL,
  "行家住宅公司": FACTION_CAL,
  "矿钻集团": FACTION_CAL,
  "波斯矿业股份": FACTION_CAL,
  "纳基维集团": FACTION_CAL,
  "深核矿业公司": FACTION_CAL,
  "空间航线巡管局": FACTION_CAL,
  "塞克斯金发展公司": FACTION_CAL,
  "现代金融": FACTION_CAL,
  "疾速快递": FACTION_CAL,
  "国家星域银行": FACTION_CAL,
  "国家档案所": FACTION_CAL,
  "工业科技": FACTION_CAL,
  "战斗研究": FACTION_CAL,
  "帕特工学院": FACTION_CAL,
  "行列": FACTION_CAL,
  "倒顶集团": FACTION_CAL,
  "速度": FACTION_CAL,
  "物流": FACTION_CAL,
  "联合警备队": FACTION_CAL,
  "军事": FACTION_CAL,
  "抵抗": FACTION_CAL,
  "无过载研究公司": FACTION_CAL,
  "速装工业": FACTION_CAL,
  "推进动力集团": FACTION_CAL,
  "莱戴集团": FACTION_CAL,
  "莱戴护卫服务公司": FACTION_CAL,
  "梯队娱乐公司": FACTION_CAL,
  "载诺集团": FACTION_CAL,
  "酷菲集团": FACTION_CAL,
  "佩克昂集团": FACTION_CAL,
  "三岛集团": FACTION_CAL,
  "耶利集团": FACTION_CAL,
  "应用知识学院": FACTION_CAL,
  "科学与贸易学会": FACTION_CAL,
  "商业俱乐部": FACTION_CAL,
  "内部安全": FACTION_CAL,
  "神学理事会": FACTION_CAL,
  "安全部队": FACTION_CAL,
  "国家档案": FACTION_CAL,

  /* ============ 盖伦特联邦 Gallente Federation ============ */
  "泛星船运": FACTION_GAL,
  "泛光银行": FACTION_GAL,
  "埃拉斯多集团": FACTION_GAL,
  "埃菲尔公司": FACTION_GAL,
  "埃拉斯多": FACTION_GAL,
  "飞马集团": FACTION_GAL,
  "加罗恩投资银行": FACTION_GAL,
  "切玛科技": FACTION_GAL,
  "促进工业": FACTION_GAL,
  "协约理事会": FACTION_GAL,
  "印刷": FACTION_GAL,
  "印普罗集团": FACTION_GAL,
  "印塔基银行": FACTION_GAL,
  "印塔基商业局": FACTION_GAL,
  "印塔基空间警察局": FACTION_GAL,
  "印塔基联合财团": FACTION_GAL,
  "卡尔": FACTION_GAL,
  "凯勒大学": FACTION_GAL,
  "参议院": FACTION_GAL,
  "复合收割": FACTION_GAL,
  "州长": FACTION_GAL,
  "度沃勒实验室": FACTION_GAL,
  "物资集团": FACTION_GAL,
  "汉": FACTION_GAL,
  "甘": FACTION_GAL,
  "波特克制药": FACTION_GAL,
  "总统团队": FACTION_GAL,
  "联邦情报处": FACTION_GAL,
  "联邦政府部": FACTION_GAL,
  "联邦最高法院": FACTION_GAL,
  "联邦海关局": FACTION_GAL,
  "联邦海军": FACTION_GAL,
  "联邦货运局": FACTION_GAL,
  "短途物流": FACTION_GAL,
  "民事法庭": FACTION_GAL,
  "星际": FACTION_GAL,
  "星形矿业": FACTION_GAL,
  "泛星": FACTION_GAL,
  "彭德保险": FACTION_GAL,
  "预算": FACTION_GAL,
  "西顿工业": FACTION_GAL,
  "视角传媒": FACTION_GAL,
  "高等": FACTION_GAL,

  /* ============ 艾玛帝国 Amarr Empire ============ */
  "HZO精炼集团": FACTION_AMR,
  "DED": null,                   // DED 属 CONCORD 体系，跨势力 → 需手填
  "Z": FACTION_AMR,
  "佐洱父子集团": FACTION_AMR,
  "卡多尔家族": FACTION_AMR,
  "卡尼迪创新集团": FACTION_AMR,
  "卡尼迪工作室": FACTION_AMR,
  "卡尼迪皇家海军": FACTION_AMR,
  "卡尼迪运输": FACTION_AMR,
  "塔什蒙贡家族": FACTION_AMR,
  "努图拉集团": FACTION_AMR,
  "国家": FACTION_AMR,
  "国家档案": FACTION_AMR,
  "土地": FACTION_AMR,
  "国防": FACTION_AMR,
  "宫廷": FACTION_AMR,
  "帝国十字军第二十四军团": FACTION_AMR,
  "帝国总装部": FACTION_AMR,
  "帝国运输": FACTION_AMR,
  "帝国议长专团": FACTION_AMR,
  "帝国认证通讯社": FACTION_AMR,
  "帝国商管局": FACTION_AMR,
  "帝国海军": FACTION_AMR,
  "帝国学院": FACTION_AMR,
  "皇室专署集团": FACTION_AMR,
  "实现": FACTION_AMR,
  "宫务大臣": FACTION_AMR,
  "星际捷运": FACTION_AMR,
  "星捷运": FACTION_AMR,
  "朱庇特内议会": FACTION_AMR,
  "杜厦铸造": FACTION_AMR,
  "柯埃佐家族": FACTION_AMR,
  "神学": FACTION_AMR,
  "神学理事会": FACTION_AMR,
  "帝国": FACTION_AMR,
  "皇室": FACTION_AMR,
  "维鲜集团": FACTION_AMR,
  "萨拉姆家族": FACTION_AMR,
  "阿狄莎波家族": FACTION_AMR,
  "联合收割": FACTION_AMR,
  "天主凝聚会": FACTION_AMR,
  "天蛇集团": FACTION_AMR,
  "古斯塔斯集团": FACTION_AMR,
  "古斯塔斯制造": FACTION_AMR,
  "斯库维塔集团": FACTION_AMR,
  "氏": FACTION_AMR,
  "艾玛内政部": FACTION_AMR,
  "艾玛海军": FACTION_AMR,
  "艾玛建设": FACTION_AMR,
  "艾玛商管局": FACTION_AMR,
  "长足食品": FACTION_AMR,
  "陆": FACTION_AMR,

  /* ============ 米玛塔尔共和国 Minmatar Republic ============ */
  "Pa": FACTION_MIN,
  "核心局面公司": FACTION_MIN,
  "土产公司": FACTION_MIN,
  "帕特": FACTION_MIN,
  "无限创造": FACTION_MIN,
  "共和安全局": FACTION_MIN,
  "共和秩序局": FACTION_MIN,
  "共和舰队": FACTION_MIN,
  "共和议会": FACTION_MIN,
  "共和国军事学院": FACTION_MIN,
  "共和国司法部": FACTION_MIN,
  "共和国大学": FACTION_MIN,
  "市政管理局": FACTION_MIN,
  "昌隆集团": FACTION_MIN,
  "朱庇特": FACTION_MIN,
  "米玛塔尔矿业联合体": FACTION_MIN,
  "罗述集团": FACTION_MIN,
  "自由扩张集团": FACTION_MIN,
  "联合收割": FACTION_MIN,
  "海德拉舰队": FACTION_MIN,

  /* ============ 补充：艾玛系 ============ */
  "格鲁汀集团": null,           // 古斯塔斯系
  "莱登船业": FACTION_GAL,        // Roden Shipyards → 盖伦特系
  "内务府": FACTION_AMR,          // Ministry of Internal Order → 艾玛系
  "自尊集团": FACTION_GAL,        // Egonics Inc. → 盖伦特系
  "锋锐工业": FACTION_GAL,        // Shapeset → 盖伦特系
  "艾玛认证通讯社": FACTION_AMR,  // Amarr Certified News
  "共和大学": FACTION_MIN,        // Republic University
  "赫迪农大学": FACTION_AMR,      // Hedion University
  "国土评估局": FACTION_AMR,      // Ministry of Assessment
  "高级教育中心": FACTION_GAL,    // Center for Advanced Studies
  "科学及贸易学会": FACTION_CAL,  // Science and Trade Institute
  "高尚用具公司": FACTION_AMR,    // Noble Appliances
  "军务部": FACTION_AMR,          // Ministry of War
  "赛毕斯托部族": null,           // Sebiestor tribe
  "艾玛达舰队": FACTION_AMR,      // Ammatar Fleet
  "艾玛达领事馆": FACTION_AMR,    // Ammatar Consulate
  "血袭者": null,                 // Blood Raiders
  "阿洛特工业": FACTION_GAL,      // Allotek Industries
  "理性思维社团": null,           // Society of Conscious Thought
  "零重力研究公司": FACTION_CAL,  // Zero-G Research Firm
  "艾玛皇家学院": FACTION_AMR,    // Royal Amarr Institute
  "战争行为学院": FACTION_CAL,    // School of Applied Knowledge
  "暗月军工联合体": null,         // 玩家/特殊组织
  "联邦防务联合会": null,         // 玩家组织
  "部族解放力量": null,           // 玩家组织
  "避难会": null,                 // The Sanctuary
  "顶峰集团": null,               // 玩家自建（多家同名）
  "材料学院": FACTION_AMR,
  "小": null,
  "军": null,
  "部": null,
  "零": null,

  /* ============ 中立 / 其他势力（需用户手填声望）============ */
  "三神避世会": null,
  "暗泽裔演化枝": null,
  "雷电裔演化枝": null,
  "熔火裔演化枝": null,
  "莫德": null,
  "朱庇特海军": null,
  "主天使集团": null,
  "守护天使集团": null,
  "救赎天使集团": null,
  "大天使集团": null,
  "忠实制造": null,
  "实力派": null,
  "信任伙伴集团": null,
  "超感集团": null,
  "外空联合矿业集团": null,
  "内凡达矿业协会": null,
  "图克尔混合企业": null,
  "天蛇集团": null,
  "古斯塔斯集团": null,
  "姐妹会": null,
  "EVE姐妹会": null,
  "星空会": null,
  "粮食救济会": null,
  "商业安全委员会": null,
  "统一合作关系部": null,
  "协约理事会": null,
  "印塔基": null,
  "克鲁夏部族": null,
  "维洛奇亚部族": null,
  "布鲁特部族": null,
  "塞毕斯托部族": null,
  "合众国护卫军": null,
  "天赋植体公司": null
};

/** 势力 id → 中文名 */
const FACTION_ZH = {};
FACTIONS.forEach(f => { FACTION_ZH[f.factionId] = f.nameZh; });

/* ------------------------------------------------------------------ *
 * 空间站名末段的设施名（用于切出公司名）
 * ------------------------------------------------------------------ */
const FACILITY_SUFFIXES = [
  "储存工厂", "生产工厂", "发展工作室", "组装车间", "办公署", "生化科技产品",
  "储存中心", "零售中心", "办公事务所", "化学精炼厂", "种植园", "仓库",
  "矿物储备", "矿冶站", "法庭", "库房", "工厂", "太空站", "办公区",
  "太空港", "造船", "实验室", "空间站", "其他",
  // 需按长度降序匹配，故把长的放前面（下列顺序仅影响同长度时的优先级）
  "后勤支援部", "信息中心", "档案馆", "出版社", "学校", "学院", "测试设施",
  "贮存舱", "贮藏舱", "储藏设施", "生化科技研究中心", "生化污染物储藏设施",
  "缺陷舱", "开采终端", "符号化剧场", "试炼复合体", "生化适应舱室",
  "突变质体农场", "运营中心", "基础教育中心", "自由殿堂", "贸易使馆",
  "监测天文台", "富勒烯纺织设施", "应用万有引力", "古控制论学院",
  "食品包装厂", "生技产品加工厂", "组装厂", "采掘中心", "采掘终端",
  // 新版站点类型（2026 年后新增，本地 SDE 表未收录时靠手填站名识别）
  "自由贸易中心", "自由贸易站", "商业中心", "贸易中心"
];

/* ------------------------------------------------------------------ *
 * 空间站数据
 * ------------------------------------------------------------------ */

let STATIONS = null;

/** 载入本地空间站表（惰性加载，失败则返回空数组） */
function loadStations() {
  if (STATIONS) return STATIONS;
  try {
    if (!fs.existsSync(STATIONS_FILE)) { STATIONS = []; return STATIONS; }
    const raw = JSON.parse(fs.readFileSync(STATIONS_FILE, "utf8"));
    STATIONS = Array.isArray(raw) ? raw : (raw.stations || []);
  } catch (e) {
    STATIONS = [];
  }
  return STATIONS;
}

/**
 * 搜索空间站。
 * @param {string} q 关键词（站名/星系名/区域名）
 * @param {number} limit 最多返回条数
 */
function searchStations(q, limit) {
  const all = loadStations();
  const key = String(q || "").trim().toLowerCase();
  if (!key) return all.slice(0, limit || 20);
  const hit = all.filter(s =>
    String(s.name || "").toLowerCase().includes(key) ||
    String(s.systemName || "").toLowerCase().includes(key) ||
    String(s.regionName || "").toLowerCase().includes(key)
  );
  return hit.slice(0, limit || 20);
}

/** 按 id 精确取空间站 */
function stationById(id) {
  const n = Number(id);
  if (!n) return null;
  return loadStations().find(s => s.id === n) || null;
}

/**
 * 从站名切出公司名。
 * 站名格式：「星系 X - 卫星 N - 公司名 设施名」，
 * 末段是「公司名 + 设施名」的组合（如「星捷运 自由贸易中心」）。
 *
 * ★ 设施名按长度降序匹配 —— 否则「库房」会先于「食品包装厂」命中，把公司名切错。
 */
function corpNameFromStationName(stationName) {
  if (!stationName) return null;
  const parts = String(stationName).split(" - ");
  const last = parts[parts.length - 1].trim();
  const sorted = FACILITY_SUFFIXES.slice().sort((a, b) => b.length - a.length);
  for (const suf of sorted) {
    if (last.endsWith(suf) && last.length > suf.length) {
      return last.slice(0, last.length - suf.length).trim();
    }
  }
  return last || null;
}

/**
 * 查公司名对应的势力。
 * 先精确匹配，再做包含匹配（公司名可能带后缀，如「加达里商业法庭」）。
 */
function factionForCorp(corpName) {
  if (!corpName) return null;
  if (Object.prototype.hasOwnProperty.call(CORP_FACTION, corpName)) {
    return CORP_FACTION[corpName];
  }
  // 包含匹配：取最长的匹配键
  let bestKey = null;
  for (const key of Object.keys(CORP_FACTION)) {
    if (corpName.includes(key) && (!bestKey || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  if (bestKey) return CORP_FACTION[bestKey];
  return undefined;   // undefined = 未识别；null = 已识别但中立（需手填）
}

/**
 * 按站名直接解析（不依赖本地表收录）。
 *
 * ★ 用途：新版本新增的空间站在 ESI 与本地 SDE 表里都还没有
 *   （实测「索巴色基 5 - 星捷运 自由贸易中心」/60000843 在两边都是 404）。
 *   用户可以手填站名，此处照样能切出公司名并识别势力。
 *
 * @param {string} stationName 站名
 * @returns {object} { corpName, factionId, factionZh, known }
 */
function resolveByName(stationName) {
  const corpName = corpNameFromStationName(stationName);
  const factionId = factionForCorp(corpName);
  const known = factionId !== undefined;
  return {
    corpName: corpName,
    factionId: known ? factionId : null,
    factionZh: known && factionId ? (FACTION_ZH[factionId] || null) : null,
    known: known
  };
}

/**
 * 解析空间站的站主信息。
 * @param {object} station stations.json 条目（可为自定义对象）
 * @returns {object} { corpName, factionId, factionZh, known }
 */
function resolveStationOwner(station) {
  if (!station) return null;
  const corpName = corpNameFromStationName(station.name);
  const factionId = factionForCorp(corpName);
  const known = factionId !== undefined;
  return {
    corpName: corpName,
    // 中立组织 factionId 为 null —— 界面提示用户手填
    factionId: known ? factionId : null,
    factionZh: known && factionId ? (FACTION_ZH[factionId] || null) : null,
    known: known
  };
}

module.exports = {
  FACTIONS,
  FACTION_ZH,
  CORP_FACTION,
  searchStations,
  stationById,
  corpNameFromStationName,
  factionForCorp,
  resolveStationOwner,
  resolveByName,
  loadStations
};
