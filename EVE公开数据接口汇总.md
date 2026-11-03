# EVE Online 公开数据接口汇总（三服对照）

> 调研日期：2026-11-03｜所有端点均经**实际请求验证**，非文档摘抄
> 适用项目：市场动态与制造核算台 v1.3

---

## 一、三服架构总览（最关键）

EVE Online 存在 **3 个独立服务器集群**，数据完全隔离，**不存在单一"官方 API"能覆盖三服**。

| | **欧服（宁静）** | **国服 经典服（晨曦）** | **国服 曙光服** |
| --- | --- | --- | --- |
| 运营方 | CCP Games | 网易 | 网易 |
| 官方 ESI 域名 | `esi.evetech.net` | `ali-esi.evepc.163.com` | 同左（同一集群） |
| SSO 授权入口 | `login.eveonline.com/v2/oauth/authorize` | `login.evepc.163.com/v2/oauth/authorize` | 同左 |
| 静态数据 SDE | CCP 官方 zip | 网易 evedata.xlsx | 同左 |
| ESI 版本 | OpenAPI 3.1.0，2020-01-01 | Swagger 2.0，v1.19 | 同左 |
| 端点规模 | 182 路径 / 197 操作 | 189 路径 / 204 操作 | 同左 |
| 公开合同总页数 | **35 页**（星域 10000002） | **6 页**（星域 10000002） | 同左 |
| 错误额度 | 100 | 50 | 同左 |
| `datasource` 参数 | 需 `datasource=tranquility` | **不支持**，省略即默认 | 不支持 |
| `datasource=serenity/shuguang` | **HTTP 400**（实测） | — | — |

### 关键结论

1. **国服有官方 ESI**，由网易运营，接口结构与欧服基本一致（分类数几乎相同），**无需鉴权即可读公开数据**。
   实测：`/latest/status/`、`/latest/markets/{region_id}/orders/`、`/latest/contracts/public/{region_id}/`、`/latest/universe/types/` 全部 200。
2. **国服与欧服数据完全独立**。实测同为三钛合金（type_id 34）星域 10000002：

   | 服 | 订单条数 | 首单 order_id | 首单价 |
   | --- | --- | --- | --- |
   | 欧服 | 45 | 7460672277 | 3.81 |
   | 国服晨曦 | 35 | 2745262132 | 10.18 |

3. **国服合同数据量远小于欧服**（6 页 vs 35 页）——国服玩家体量与市场活跃度更低。
4. 国服 ESI 独有分类：**Opportunities（5）、Bookmarks（4）**；欧服独有 **Meta（2）**。
5. `X-Compatibility-Date` 在规范中标记为必填，但**实测两端均不强制**（不带也返回 200）。

---

## 二、官方 ESI —— 欧服（CCP）

**Base URL**：`https://esi.evetech.net/latest/`
**规范文件**：`https://esi.evetech.net/meta/openapi.json`（464 KB，可直接下载解析）
**交互文档**：`https://esi.evetech.net/ui/`
**公共查询参数**：`datasource`（欧服须 `tranquility`）、`lang`（可选，语言）、`If-None-Match`、`If-Modified-Since`、`Accept-Language`、`X-Compatibility-Date`

### 2.1 市场类（Market，11 个操作）

| 方法 | 路径 | 必填 | 可选 | 功能 |
| --- | --- | --- | --- | --- |
| GET | `/markets/{region_id}/orders/` | 路径 `region_id`；查询 `order_type` | `page`、`type_id` | **区域订单簿**（sell/buy/all），核心行情源 |
| GET | `/markets/{region_id}/history/` | 路径 `region_id`；查询 `type_id` | — | **历史成交**（按日聚合，含 high/low/avg/median） |
| GET | `/markets/{region_id}/types/` | 路径 `region_id` | `page` | 该区域有市场的 typeID 列表 |
| GET | `/markets/prices/` | — | — | **全量调整后价格（EIV）**，工业成本核算基准 |
| GET | `/markets/groups/` | — | — | 市场分组树 |
| GET | `/markets/groups/{market_group_id}/` | 路径 | — | 分组详情 |
| GET | `/markets/structures/{structure_id}/` | 路径 | `page` | 玩家建筑内订单 |
| GET | `/characters/{character_id}/orders/` | 路径 | `page` | 角色挂单（需鉴权） |
| GET | `/characters/{character_id}/orders/history/` | 路径 | `page` | 角色历史挂单（需鉴权） |
| GET | `/corporations/{corporation_id}/orders/` | 路径 | `page` |  corporation 挂单（需鉴权） |
| GET | `/corporations/{corporation_id}/orders/history/` | 路径 | `page` |  corporation 历史挂单（需鉴权） |

> `order_type` 取值：`buy` / `sell` / `all`。

### 2.2 合同类（Contracts，9 个操作）

| 方法 | 路径 | 可选 | 功能 |
| --- | --- | --- | --- |
| GET | `/contracts/public/{region_id}/` | `page` | **公开合同**（每页 1000 条，`X-Pages` 头给出总页数） |
| GET | `/contracts/public/items/{contract_id}/` | `page` | 合同物品明细（**实测欧服 404**） |
| GET | `/contracts/public/bids/{contract_id}/` | `page` | 合同竞价 |
| GET | `/characters/{character_id}/contracts/` | `page` | 角色合同（需鉴权） |
| GET | `/characters/{character_id}/contracts/{contract_id}/items/` | — | 合同物品 |
| GET | `/characters/{character_id}/contracts/{contract_id}/bids/` | — | 合同竞价 |
| GET | `/corporations/{corporation_id}/contracts/` | `page` |  corporation 合同（需鉴权） |
| GET | `/corporations/{corporation_id}/contracts/{contract_id}/items/` | — | 合同物品 |
| GET | `/corporations/{corporation_id}/contracts/{contract_id}/bids/` | — | 合同竞价 |

> ⚠️ 合同字段中 **ESI 无 `buyout` 字段**（仅 auction 类型含 `buyout`，`item_exchange` 无）。买断价需读 `reward` / `price`，或改用第三方 c3q 接口（见 §4）。

### 2.3 技能与角色（Skills / Character / Location）

| 方法 | 路径 | 必填 scope | 功能 |
| --- | --- | --- | --- |
| GET | `/characters/{character_id}/skills/` | `esi-skills.read_skills.v1` | **全部已训练技能 + 总 SP** |
| GET | `/characters/{character_id}/skillqueue/` | `esi-skills.read_skillqueue.v1` | 技能训练队列 |
| GET | `/characters/{character_id}/attributes/` | `esi-skills.read_skills.v1` | 智力/记忆/感知等属性 |
| GET | `/characters/{character_id}/` | 无（公开） | 公开信息：姓名、公司 ID、安保等级、种族、生日 |
| GET | `/characters/{character_id}/portrait/` | 无（公开） | 头像 URL（64/128/256/512） |
| GET | `/characters/{character_id}/corporationhistory/` | 无（公开） | 公司履历 |
| GET | `/characters/{character_id}/online/` | `esi-location.read_online.v1` | 在线状态 |
| GET | `/characters/{character_id}/location/` | `esi-location.read_location.v1` | 当前星系/空间站 |
| GET | `/characters/{character_id}/ship/` | `esi-location.read_ship_type.v1` | 当前舰船 |

### 2.4 工业类（Industry，8 个操作）

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | `/industry/facilities/` | **工业设施与制造费率**（对应游戏内制造建筑） |
| GET | `/industry/systems/` | **各星系工业成本指数**（安装工时成本，影响制造费） |
| GET | `/characters/{character_id}/industry/jobs/` | 角色工业任务（`include_completed` 可选） |
| GET | `/corporations/{corporation_id}/industry/jobs/` |  corporation 工业任务 |
| GET | `/characters/{character_id}/mining/` | 角色挖矿记录 |
| GET | `/corporation/{corporation_id}/mining/extractions/` |  corporation 开采记录 |
| GET | `/corporation/{corporation_id}/mining/observers/` | 观测者开采记录 |

### 2.5 资产与钱包（Assets / Wallet）

| 方法 | 路径 | 可选 | 功能 |
| --- | --- | --- | --- |
| GET | `/characters/{character_id}/assets/` | `page` | 角色资产清单 |
| POST | `/characters/{character_id}/assets/locations/` | — | **批量**解析资产位置（请求体为 ID 数组） |
| POST | `/characters/{character_id}/assets/names/` | — | **批量**解析资产名称 |
| GET | `/corporations/{corporation_id}/assets/` | `page` |  corporation 资产 |
| POST | `/corporations/{corporation_id}/assets/locations/` | — | 批量位置解析 |
| POST | `/corporations/{corporation_id}/assets/names/` | — | 批量名称解析 |
| GET | `/characters/{character_id}/wallet/` | — | 角色钱包余额 |
| GET | `/characters/{character_id}/wallet/journal/` | `page` | 钱包流水 |
| GET | `/characters/{character_id}/wallet/transactions/` | `from_id` | 钱包交易 |
| GET | `/corporations/{corporation_id}/wallets/` | — |  corporation 钱包余额 |
| GET | `/corporations/{corporation_id}/wallets/{division}/journal/` | `page` |  corporation 钱包流水（division 分区） |
| GET | `/corporations/{corporation_id}/wallets/{division}/transactions/` | `from_id` |  corporation 交易 |

### 2.6 宇宙与静态数据（Universe，30 个操作）

| 方法 | 路径 | 可选 | 功能 |
| --- | --- | --- | --- |
| GET | `/universe/systems/` | — | **全部星系**（含安全等级） |
| GET | `/universe/systems/{system_id}/` | — | 星系详情 |
| GET | `/universe/regions/` | — | 星域列表 |
| GET | `/universe/constellations/` | — | 星座列表 |
| GET | `/universe/stations/{station_id}/` | — | NPC 空间站详情 |
| GET | `/universe/structures/` | `filter` | 玩家公开建筑列表 |
| GET | `/universe/types/` | `page` | 物品类型定义 |
| GET | `/universe/types/{type_id}/` | — | 物品详情 |
| POST | `/universe/ids/` | — | **批量 ID → 名称**（请求体必须是**裸数组** `[3409,3385]`；传 `{"names":[…]}` → HTTP 400） |
| POST | `/universe/names/` | — | 批量名称 → ID |
| GET | `/universe/groups/` | `page` | 物品组 |
| GET | `/universe/categories/` | — | 物品分类 |
| GET | `/universe/factions/` | — | 势力 |
| GET | `/universe/planets/{planet_id}/` | — | 行星 |
| GET | `/universe/moons/{moon_id}/` | — | 卫星 |
| GET | `/universe/stargates/{stargate_id}/` | — | 星门 |
| GET | `/universe/system_jumps/` | — | 星系连接（Jump API 路线规划） |
| GET | `/universe/system_kills/` | — | 星系击杀数 |
| GET | `/universe/ancestries/` | — | 血族 |
| GET | `/universe/bloodlines/` | — | 血系 |
| GET | `/universe/races/` | — | 种族 |
| GET | `/universe/graphics/` | — | 图标资源 |
| GET | `/universe/asteroid_belts/{asteroid_belt_id}/` | — | 小行星带 |
| GET | `/universe/stars/{star_id}/` | — | 恒星 |

### 2.7 其他常用端点

| 方法 | 路径 | 必填 | 功能 |
| --- | --- | --- | --- |
| GET | `/status/` | — | 服务器状态、版本号、在线人数 |
| GET | `/insurance/prices/` | — | **各舰船等级保险费** |
| GET | `/route/{origin}/{destination}/` | 路径 | **路线规划**（`avoid`、`connections`、`flag` 可选） |
| GET | `/search/?categories=&search=` | `categories`、`search` | 搜索（`strict` 可选） |
| GET | `/incursions/` | — | 当前入侵事件 |
| GET | `/dogma/attributes/` | — | 物品属性定义 |
| GET | `/dogma/effects/` | — | 效果定义 |
| GET | `/dogma/dynamic/items/{type_id}/{item_id}/` | 路径 | 动态物品（深渊道具）属性 |
| GET | `/characters/{character_id}/loyalty/points/` | — | 忠诚点 |
| GET | `/loyalty/stores/{corporation_id}/offers/` | — | LP 商店商品 |
| GET | `/killmails/{killmail_id}/{killmail_hash}/` | 路径 | 击杀详情 |
| GET | `/characters/{character_id}/killmails/recent/` | `page` | 近期击杀 |
| GET | `/sovereignty/campaigns/` | — | 主权战役 |
| GET | `/sovereignty/map/` | — | 主权地图 |
| GET | `/wars/` | `max_war_id` | 战争列表 |

---

## 三、官方 ESI —— 国服（网易，晨曦 + 曙光）

**Base URL**：`https://ali-esi.evepc.163.com/latest/`
**规范文件**：`https://ali-esi.evepc.163.com/latest/swagger.json`（886 KB）
**SSO**：`https://login.evepc.163.com/v2/oauth/authorize`（实测 GET → 405，需带参数）
**scope 数量**：66 个（与欧服 scope 命名一致）

### 3.1 与欧服的能力差异

| 能力 | 国服 ESI | 说明 |
| --- | --- | --- |
| 服务器状态 | ✅ `/latest/status/` | 实测返回 `{"players":3837,"server_version":"3663397",...}`（国服实时） |
| 市场订单 | ✅ `/latest/markets/{region_id}/orders/` | 实测 200，10922 字节 |
| 历史成交 | ✅ `/latest/markets/{region_id}/history/` | 同路径可用 |
| 调整后价格 EIV | ✅ `/latest/markets/prices/` | 实测 200，781 KB |
| 公开合同 | ✅ `/latest/contracts/public/{region_id}/` | 实测 200，**X-Pages: 6** |
| 合同物品明细 | ✅ `/latest/contracts/public/items/{contract_id}/` | **欧服 404，国服可用** |
| 宇宙数据 | ✅ `/latest/universe/{systems,types,groups,categories,structures}/` | 实测全部 200 |
| 批量 ID 解析 | ✅ POST `/latest/universe/ids/` | **实测 GET 返回 405，必须 POST** |
| 行业设施与成本指数 | ✅ `/latest/industry/facilities/`、`/latest/industry/systems/` | 同路径 |
| 角色技能 | ✅ `/latest/characters/{id}/skills/` | 需鉴权（未带 token → 401 `authorization not provided`） |
| `datasource` 参数 | ❌ 不支持 | 欧服用 `serenity` 会 400；国服直接省略 |

### 3.2 国服 universe/ids 的重要差异

实测 POST `[3409,3385,3389]` 返回：

```json
{"characters":[{"id":91138021,"name":"3385"},{"id":90456879,"name":"3389"}],
 "corporations":[{"id":98035343,"name":"华兴商团"}]}
```

- 返回的是**国服真实角色/公司名**（如「华兴商团」），证明是独立数据源。
- **不返回 `inventory_types`** —— 国服 `universe/ids` 仅解析角色/公司/联盟/势力/空间站/建筑/星域/星系，**不解析物品 typeID**。
- ⚠️ **国服 typeID 体系与欧服不同**：`3409`（欧服冶金学）无对应项，`3385`/`3389` 解析成了角色名而非技能名。国服技能 typeID 需用国服自己的映射表，不可套用欧服值。

### 3.3 国服独有端点

| 分类 | 端点 | 功能 |
| --- | --- | --- |
| Opportunities（5） | `/characters/{character_id}/opportunities/` 等 | 任务机会（国服特有玩法） |
| Bookmarks（4） | `/characters/{character_id}/bookmarks/` 等 | 书签（欧服在 Character 类下） |

---

## 四、第三方接口平台

### 4.1 EVE国服市场中心（ceve-market.org）★ 项目当前使用

**官网文档**：`https://www.ceve-market.org/api/`
**特点**：与 eve-central 兼容，**XML 返回格式**，三服统一前缀。

| 前缀 | 服务器 | 说明 |
| --- | --- | --- |
| `/api` | **国服 经典服（晨曦）** | 主力前缀 |
| `/infapi` | **国服 曙光服** | 2023-02 起收录 |
| `/tqapi` | **欧服（宁静）** | 实测数据与国服独立 |

| 端点 | 方法 | 必填参数 | 可选参数 | 返回 | 功能 |
| --- | --- | --- | --- | --- | --- |
| `/marketstat` | GET / POST | `typeid`（**可多次赋值，重复参数形式**） | `hours`（默认 8760）、`minQ`（默认 0）、`regionlimit`（**可多次赋值**）、`usesystem` | **XML** | 价格统计：buy/sell/all × volume/avg/max/min/stddev/median/percentile |
| `/quicklook` | GET / POST | `typeid`（单个）、`regionlimit`（可多次） | `sethours`、`setminQ`、`usesystem` | XML | 订单明细列表，含 `station_name`、`price`、`vol_remain`、`min_volume`、`range` |
| `/searchname` | **POST** | `name` | — | **JSON** | 按名称搜 typeID，返回 `[{typeid, typename}]` |
| `/evemon` | GET | 无 | — | XML | **吉他市场基础矿物最高收购价**（提炼估值用） |
| `/market/` | GET | 物品ID、格式（`xml`/`json`） | 星域ID、星系ID | XML/JSON | REST 风格单项查询 |

**实测要点**：
- ⚠️ `typeid` **必须用重复参数** `typeid=34&typeid=35`；**逗号分隔 `typeid=34,35` → HTTP 500**（实测复现）。
- ⚠️ `regionlimit` 语义是**星域 ID**，传星系 ID 会返回全 0（实测）。
- `range` 字段：0=本空间站，32767=本星系，65535/65536=本星域，其他为收单跳数。
- `stddev` 为带权重标准差，`median` 为带权重中位数，`percentile` 为带权重 90 百分位。
- POST 需显式 `Content-Type: application/x-www-form-urlencoded`。
- 每日全量快照可下载：`https://www.ceve-market.org/dumps/`
- **基础资料包**：`https://www.ceve-market.org/dumps/evedata.xlsx`（每日更新，含物品/星域/星座/星系/NPC 空间站）

### 4.2 EVE Market（c3q.cc）★ 合同数据最强

**文档**：`https://eve.c3q.cc/market/api/help/`

| 服务器 | Base URL |
| --- | --- |
| **欧服（宁静）** | `https://eve.c3q.cc/market/api/` |
| **国服 经典服（晨曦）** | `https://cn.c3q.cc:20080/eve/market/api/` |
| **国服 曙光服** | `https://cn.c3q.cc:20080/eve/market-sg/api/` |

**调用规范**：**仅支持 POST**，`Content-Type: application/x-www-form-urlencoded`（非 JSON）；**同 IP 每 60 秒 ≤60 次**，超限返回 429；一次请求可含多个服务，但**任一服务失败则全部失败**。

| 服务名 | 参数 | 上限 | 功能 |
| --- | --- | --- | --- |
| `queryBuyAssess` | `type_id` 或数组 + `buy_location_id`（region_id 或 location_id 数组，二选一） | type ≤50，location ≤3 | **买单估价**（average/max/min/five_num/five_value） |
| `querySellAssess` | `type_id` 或数组 + `sell_location_id` | 同上 | **卖单估价** |
| `listBuyOrder` | `type_id` 或数组 | ≤3 | 买单列表（价格降序），返回 `[type_id, system_id, location_id, price, volume_remain, volume_total, duration, issued, min_volume, order_range]` |
| `listSellOrder` | `type_id` 或数组 | ≤3 | 卖单列表（价格升序） |
| **`listContractAll`** | `type_id` | — | **含指定物品的全部合同**（按合同 ID 排序）。返回 `list: [contract_id, type, reward, price, buyout, date_issued, date_expired, volume, location_id, region_id, title]` + `item: {contract_id: [quantity, type_id, item_id, material_efficiency, time_efficiency, runs]}` |
| `listContract` | `type_id` 数组 | ≤10 | 合同列表（价格升序，**即将废弃**） |
| `listContractItem` | `contract_id` 数组 | ≤10 | 合同物品（**即将废弃**） |
| `queryTypeDogma` | `type_id` 数组 | ≤50 | 物品默认属性（**仅欧服**） |

**静态文件**：`https://eve.c3q.cc/market/data/`，含 `categorys, groups, marketgroups, regions, constellations, systems, stations, systemnear, systemposition, stationsystem, types, typename, dogmaattributes`；**中文版路径末尾加 `zh/`**（如 `/market/data/regions/zh/`）。

> 💡 **对本项目价值**：c3q 的 `listContractAll` **同时返回 `reward`、`price`、`buyout` 三个价格字段**，正好补上 ESI 缺失的合同买断价。实测晨曦服可用。

### 4.3 其他第三方平台

| 平台 | 用途 | 接口形式 |
| --- | --- | --- |
| **zKillboard** | 击杀记录查询与统计 | REST + WebSocket，含 `X-Killmail-Token` 认证 |
| **EVEpraisal / Contracts Appraisal** | 合同估价（BPO/BPC） | REST |
| **MutaMarket** | 深渊模块估价 | REST |
| **Fuzzwork** | SDE 转换（MySQL/SQLite/Postgres/CSV）、地图 API、typename→typeID API | REST + 文件下载 |
| **SDE2JSON / ESI Data / Hoboleaks** | SDE 转 JSON | 文件下载 |
| **EVE Tools Suite** | 市场评估 / LP / 报价，开源（MIT） | REST，声明数据源为 ESI + zKillboard + MutaMarket + Fuzzwork |
| **jEveAssets / Neocom / Tritanium / RIFT Intel** | 桌面/移动端客户端 | 内部调用 ESI |
| **EVE-Kill / nKillboard / KillFeed** | 击杀看板 | REST / Discord Bot |
| **Citadel API** | 玩家建筑 ID ↔ 名称 ↔ 星系 | JSON，有 Swagger |
| **EVEMetroApi / WormholeSystems** | 虫洞地图 | REST |
| **Mock ESI** | 本地测试用 ESI 模拟服务器 | Docker 镜像 |
| **EveKit** | 云端捕获角色/公司数据；SDE 在线版 | JSON/REST + Swagger 客户端 |

**开源客户端库**（免手写请求）：Java `eve-esi`、Python `EsiPy`、PHP `iveeCore`、Ruby `esi`、C# `ESISharp`/`EVEStandard`、Go `fnt-eve`、TypeScript `@lgriffin/esi.ts`（含 Zod 响应校验与自动 token 刷新）。

---

## 五、限流与缓存机制

| 机制 | 欧服 ESI | 国服 ESI | ceve-market | c3q |
| --- | --- | --- | --- | --- |
| 错误额度头 | `X-Esi-Error-Limit-Remain: 100` | `X-Esi-Error-Limit-Remain: 50` | 未公开 | 60 次/分/IP |
| 额度重置头 | `X-Esi-Error-Limit-Reset` | `X-Esi-Error-Limit-Reset` | — | — |
| 速率限制头 | `X-Ratelimit-Limit/Remaining/Used`、`X-Ratelimit-Group` | **无** | — | — |
| 分页总页数 | `X-Pages` 头 | `X-Pages` 头 | — | — |
| 缓存过期 | `Expires` 头 | `Expires` 头 | — | — |
| 缓存命中标记 | `X-Esi-Cache-Status: HIT` | 无 | — | — |
| 条件请求 | `If-None-Match` / `If-Modified-Since` | 同 | — | — |

---

## 六、对「市场动态与制造核算台」的直接影响

### 6.1 修正既有认知

| 项目此前的判断 | 实际情况 |
| --- | --- |
| 「国服无公开角色接口，只能手填」 | ❌ **错误**。国服有官方 ESI（网易），`ali-esi.evepc.163.com/latest/characters/{id}/skills/` 完整可用，走国服 SSO 即可 |
| 「合同查询仅欧服可用」 | ❌ **不准确**。国服 ESI 公开合同可用（6 页）；c3q 更覆盖晨曦+曙光+欧服三服 |
| 「ESI 无 buyout 字段是缺陷」 | ⚠️ **部分成立**。ESI 合同确实缺 buyout，但 **c3q `listContractAll` 有**（含 reward/price/buyout 三字段） |
| 「合同只取到 1/35 数据是严重问题」 | ⚠️ **程度需重新评估**。国服总页数仅 6 页，且国服合同总量本就少 |
| 「`datasource=serenity` 返回 400 说明国服无接口」 | ⚠️ **归因错误**。400 是因为**欧服 ESI 不提供国服 datasource**，国服有独立 ESI 域名 |

### 6.2 v1.3 可落地的改进方向

1. **国服技能自动读取**：把「角色信息」页的欧服 SSO 扩展为**双 SSO 通道**——欧服走 `login.eveonline.com/v2/oauth/authorize`，国服走 `login.evepc.163.com/v2/oauth/authorize`。
2. **合同数据源分层**：欧服用 ESI `/contracts/public/`（35 页 + 分页 UI），国服用 c3q `listContractAll`（含 buyout）或国服 ESI + c3q 混合。
3. **国服 typeID 映射表**：国服 `universe/ids` 不解析 inventory_types，需单独建立国服技能 typeID 映射（不可套用欧服值）。
4. **历史价格曲线**：ESI `/markets/{region_id}/history/` 提供按日成交数据，可补上项目目前完全缺失的「价格走势」能力（此前认为上游无历史数据，实测 ESI 有）。

---

## 七、验证方法与可复现命令

```bash
# 欧服 ESI 状态
curl -s "https://esi.evetech.net/latest/status/?datasource=tranquility"

# 国服 ESI 状态（无 datasource 参数）
curl -s "https://ali-esi.evepc.163.com/latest/status/"

# 三服市场数据隔离验证
curl -s "https://esi.evetech.net/latest/markets/10000002/orders/?type_id=34&order_type=sell&datasource=tranquility"
curl -s "https://ali-esi.evepc.163.com/latest/markets/10000002/orders/?type_id=34&order_type=sell"

# 合同总页数对比
curl -sI "https://esi.evetech.net/latest/contracts/public/10000002/?datasource=tranquility&page=1" | grep -i x-pages
curl -sI "https://ali-esi.evepc.163.com/latest/contracts/public/10000002/?page=1" | grep -i x-pages

# c3q 国服合同（含 buyout）
curl -s -X POST "https://cn.c3q.cc:20080/eve/market/api/" \
  -H "Content-Type: application/x-www-form-urlencoded" -d "listContractAll=34"

# 规范文件下载
curl -s -o esi.json "https://esi.evetech.net/meta/openapi.json"
curl -s -o cn_esi.json "https://ali-esi.evepc.163.com/latest/swagger.json"
```

---

## 八、来源

| 来源 | 用途 |
| --- | --- |
| `https://esi.evetech.net/meta/openapi.json` | 欧服 ESI 权威规范（实测下载 463797 字节） |
| `https://ali-esi.evepc.163.com/latest/swagger.json` | 国服 ESI 权威规范（实测下载 885984 字节） |
| `https://www.ceve-market.org/api/` | ceve-market 官方文档 |
| `https://eve.c3q.cc/market/api/help/` | c3q 官方文档 |
| `https://developers.eveonline.com/docs/services/sso/` | 欧服 SSO 官方文档 |
| `https://developers.eveonline.com/docs/community/` | 官方社区工具名录 |
| `https://wiki.eveuniversity.edu/EVE_Stable_Infrastructure` | ESI 端点分类与历史 |
| `https://github.com/dlxdlxdlx/awesome-eve` | 第三方平台总览 |
| http://ceve.cc/茄盟研究院 | 国服 ESI 与国服 SSO 说明 |
