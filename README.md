# EVE 辅助工具

> 把游戏里的真实角色状态拉下来，自动代入官方工业公式，实时算出「做一单赚不赚、每天能做多少」。

面向 EVE Online 玩家（欧服 / 国服晨曦 / 国服曙光）的本地优先角色数据同步与收益核算工具。
**独立于「市场动态与制造核算台」项目**，自有代码与数据。

---

## 核心特性

- **角色数据自动同步**：官方 ESI 授权后，技能、属性、钱包、资产、工业任务自动拉取并本地存档
- **技能参数自动代入**：14 项技能 → 税率、制造时间、槽位、提炼产出、研究速度 五类系数
- **公式对齐官方**：税率、ME/TE 取整、制造费口径全部按 CCP 文档与 EVEU Wiki 校正
  （销售税 `7.5% × (1−0.11×等级)`、经纪费 `3% − 0.3%/级` 减法）
- **三服原生支持**：欧服（宁静）、国服经典服（晨曦）、国服曙光服，各自独立的数据源与 SSO
- **内置完整数据库**：16 张数据表（SDE + 官方包 + 人工维护表），约 11 MB
- **命名分离**：后台用英文名匹配（跨服稳定），前台显示国服中文名
- **零第三方依赖**：仅 Node.js 内置模块 + 原生前端

---

## 目录

```
├─ EVE辅助工具.cmd          一键入口（Windows，双击即用）
├─ EVE辅助工具.sh           一键入口（macOS / Linux / WSL）
├─ server.js              本地服务（静态托管 + SSO 流程 + ESI 代理 + 业务接口）
├─ src/core/
│  ├─ servers.js          三服配置、57 个 ESI 端点、14 组 scope
│  ├─ esi-client.js       ESI 客户端（三服统一入口，含缓存）
│  ├─ auth.js             PKCE SSO（三服双通道）、令牌交换与刷新
│  ├─ profiles.js         角色档案、技能同步、变化检测
│  ├─ skill-map.js        技能映射桥接表（英文名 ↔ typeID ↔ 中文名）
│  ├─ skills.js           技能效果与计算内核（税率从 JSON 表读）
│  └─ *.test.js           自检脚本
├─ deploy/
│  ├─ systemd/           systemd 服务单元（沙箱加固）
│  ├─ nginx/             反向代理配置（TLS + 分级限流）
│  └─ scripts/deploy.sh  一键部署脚本
├─ src/data/
│  ├─ store.js            静态库加载 + 名称解析 + 显示回退链
│  ├─ fetcher.js          ESI 拉取设施费率/成本指数/EIV/订单/历史
│  └─ *.test.js
├─ scripts/
│  ├─ launch.js           本地启动器核心（菜单/端口探测/健康检查/进程管理）
│  ├─ build_sde.py        从 SDE 构建 7 张表
│  ├─ build_cn_names.py   从官方 evedata.xlsx 构建 5 张表
│  └─ _xlsx_reader.py     纯标准库 xlsx 读取器（替代 openpyxl）
├─ data/sde/              16 张运行时数据表
├─ docs/
│  ├─ 项目记录.md          功能分析、M1 交付、里程碑、风险
│  └─ 计算公式参考.md      每个公式的官方出处、精确值、易错点
└─ EVE公开数据接口汇总.md  三服接口全集与参数表
```

---

## 构建数据

```bash
# 1. 从 SDE 构建（蓝图需 YAML 版 zip）
python3 scripts/build_sde.py --sde <SDE目录> --zip <_sde.zip>

# 2. 从官方每日包构建中文名
python3 scripts/build_cn_names.py --xlsx <evedata.xlsx>
```

官方每日包下载地址：`https://www.ceve-market.org/dumps/evedata.xlsx`

---

## 运行测试

```bash
node src/core/skills.test.js       # 计算内核自检（38 项）
node src/core/esi-client.test.js   # 三服连通性实测（30 项，需联网）
node src/core/m2.test.js           # 授权与档案（68 项）
node src/core/m2-e2e.test.js       # 技能同步端到端（17 项，需联网）
node src/data/store.test.js        # 数据层与命名分离（49 项）
node src/data/fetcher.test.js      # 数据获取与缓存（19 项，需联网）
node src/core/user-store.test.js   # 多用户隔离、会话与令牌加密（76 项）
```

当前状态：**297 项全部通过**（离线 231 项 + 需联网 66 项）

---

## 运行

### 一键脚本（推荐）

| 平台 | 操作 |
| --- | --- |
| Windows | 双击 `EVE辅助工具.cmd` |
| macOS / Linux / WSL | `./EVE辅助工具.sh` |

进入交互菜单：启动（前台/后台）、停止、重启、查看状态、打开界面、查看日志、运行自检。

也可以直接下命令：`start` / `bg` / `stop` / `restart` / `status` / `open` / `logs` / `test`，
常用选项 `--port 8660`、`--multi-user`、`--no-browser`。

启动器会自动探测空闲端口、健康检查确认就绪后才拉起浏览器，已在运行时不重复启动，
多实例可并行且能一次全部停止。详见 [docs/本地使用说明.md](docs/本地使用说明.md)。

### 手动启动

```bash
node server.js
# 打开 http://localhost:8657
```

默认监听 `127.0.0.1`、单用户模式（不校验口令），适合本地开发。

### 服务器部署

```bash
sudo bash deploy/scripts/deploy.sh
```

详见 `docs/服务器部署指南.md`。要点：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 只绑回环，由 Nginx 反代对外 |
| `PORT` | `8657` | 监听端口 |
| `BASE_URL` | — | 外部基址，用于推导 SSO 回调 |
| `EVE_CLIENT_ID` | — | 应用 Client ID |
| `EVE_MULTI_USER` | 未设 | 设 `1` 启用注册+登录+数据隔离 |
| `EVE_SALT` | 自动生成 | 服务端盐（迁移服务器时必须保留） |
| `TRUST_PROXY` | 未设 | 设 `1` 后按 `X-Forwarded-For` 取真实 IP |

**公网部署的两条硬性要求**：
1. `EVE_MULTI_USER=1` —— 否则任何人都能读你的角色数据
2. Node 只监听 `127.0.0.1` —— 公网入口唯一且必经 Nginx 的 TLS 与限流

多用户模式下每个账号有独立的数据目录，EVE 令牌以 AES-256-GCM 加密落盘。

首次使用需在「设置」页填写 **Client ID**（在 EVE 开发者后台注册应用，
回调地址填 `http://localhost:8657/sso/callback`），或设置环境变量 `EVE_CLIENT_ID`。

---

## 三服数据源

| 服务器 | 官方 ESI | SSO | 市场补充 |
| --- | --- | --- | --- |
| 欧服（宁静） | `esi.evetech.net/latest` | `login.eveonline.com` | ceve `/tqapi`、c3q `eve.c3q.cc` |
| 国服 晨曦 | `ali-esi.evepc.163.com/latest` | `login.evepc.163.com` | ceve `/api`、c3q `cn.c3q.cc:20080/eve/market/api/` |
| 国服 曙光 | 同上（**ESI 不区分服**） | 同上 | **c3q `cn.c3q.cc:20080/eve/market-sg/api/`**、ceve `/infapi` |

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/项目记录.md](docs/项目记录.md) | 功能分析、模块设计、数据库设计、M1 交付、里程碑、风险 |
| [docs/计算公式参考.md](docs/计算公式参考.md) | 每个公式的官方出处、精确数值、易错点 |
| [EVE公开数据接口汇总.md](EVE公开数据接口汇总.md) | 三服接口全集与参数表（官方文档 + 第三方平台） |

---

## 许可证

待定。
