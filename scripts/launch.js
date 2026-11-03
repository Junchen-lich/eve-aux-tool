#!/usr/bin/env node
"use strict";

/**
 * EVE 辅助工具 —— 本地一键入口
 *
 * 全部功能整合于此脚本，Windows 下双击「EVE辅助工具.cmd」即可，
 * Linux / macOS / WSL 下执行「./EVE辅助工具.sh」。
 *
 * 用法：
 *   node scripts/launch.js                 交互菜单（默认）
 *   node scripts/launch.js start           前台启动（Ctrl+C 停止）
 *   node scripts/launch.js bg              后台启动（终端可关）
 *   node scripts/launch.js stop            停止服务
 *   node scripts/launch.js restart         重启（后台模式）
 *   node scripts/launch.js status          查看运行状态
 *   node scripts/launch.js open            仅打开浏览器界面
 *   node scripts/launch.js logs            查看最近日志
 *   node scripts/launch.js test            运行自检测试
 *
 * 公共选项：
 *   --port <n>      起始端口，被占用时自动顺延
 *   --multi-user    启用多用户模式（注册 + 登录 + 数据隔离）
 *   --no-browser    不自动打开浏览器
 *
 * 职责：
 *   1. 检查 Node 版本、内置数据表是否就绪
 *   2. 读取 .env（不覆盖已存在的环境变量）
 *   3. 预选空闲端口，避免启动即失败
 *   4. 拉起 server.js：前台透传日志，后台写日志文件并落 PID
 *   5. 轮询 /healthz 确认真实端口（顺延后也能找到）并自动打开浏览器
 *   6. 若本工具已在运行，直接开浏览器而不重复启动
 */

const { spawn, exec } = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");
const readline = require("readline");

const ROOT = path.resolve(__dirname, "..");
const USER_DIR = path.join(ROOT, "用户数据");
const LOG_DIR = path.join(USER_DIR, "logs");
const PID_FILE = path.join(USER_DIR, "server.pid");
const PORT_FILE = path.join(USER_DIR, "server.port");
const SERVER_JS = path.join(ROOT, "server.js");
const SERVICE_NAME = "eve-aux-tool";
const DEFAULT_PORT = 8657;
const PORT_SCAN = 20;          // 与 server.js 的端口回退上限保持一致
const MIN_NODE_MAJOR = 18;
const HEALTH_TIMEOUT = 1500;

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2);

const FLAGS = {
  background: argv.includes("--background") || argv.includes("-b"),
  noBrowser: argv.includes("--no-browser"),
  multiUser: argv.includes("--multi-user"),
  pipe: argv.includes("--pipe"),
  help: argv.includes("--help") || argv.includes("-h")
};

const COMMANDS = ["start", "bg", "stop", "restart", "status", "open", "logs", "test", "menu"];
let command = "";
for (const a of argv) {
  if (!a.startsWith("-") && COMMANDS.includes(a)) { command = a; break; }
}

function argValue(name) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  const hit = argv.find((a) => a.startsWith(name + "="));
  return hit ? hit.slice(name.length + 1) : "";
}

/* ------------------------------------------------------------------ *
 * 终端输出
 * ------------------------------------------------------------------ */
const C = {
  reset: "\u001b[0m", dim: "\u001b[2m", bold: "\u001b[1m",
  cyan: "\u001b[36m", green: "\u001b[32m", yellow: "\u001b[33m", red: "\u001b[31m"
};
const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
function paint(color, text) { return useColor ? C[color] + text + C.reset : text; }
function line(text = "") { console.log(text); }

function banner(title) {
  line();
  line(paint("cyan", paint("bold", "  EVE 辅助工具")) + paint("dim", "  ·  " + (title || "本地控制台")));
  line(paint("dim", "  ────────────────────────────────────────────"));
}

/* ------------------------------------------------------------------ *
 * 预检
 * ------------------------------------------------------------------ */
function checkNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    line(paint("red", "✗ Node.js 版本过低：" + process.versions.node));
    line("  需要 Node.js " + MIN_NODE_MAJOR + " 及以上，请到 https://nodejs.org 下载 LTS 版本。");
    process.exit(1);
  }
}

function checkAssets() {
  if (!fs.existsSync(SERVER_JS)) {
    line(paint("red", "✗ 找不到 server.js：") + SERVER_JS);
    line("  请在项目根目录下运行本脚本。");
    process.exit(1);
  }
  const sdeDir = path.join(ROOT, "data", "sde");
  if (!fs.existsSync(sdeDir) || fs.readdirSync(sdeDir).length === 0) {
    line(paint("yellow", "⚠ 内置数据表缺失（data/sde 为空）"));
    line("  部分页面会不可用。可参考 docs/本地使用说明.md 重新构建数据表。");
  }
}

/* ------------------------------------------------------------------ *
 * .env 载入（不覆盖外部已设置的环境变量）
 * ------------------------------------------------------------------ */
function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return false;
  let text;
  try { text = fs.readFileSync(envPath, "utf8"); }
  catch (e) { return false; }
  let applied = 0;
  for (const raw of text.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const idx = s.indexOf("=");
    if (idx <= 0) continue;
    const key = s.slice(0, idx).trim();
    let val = s.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = val;
    applied++;
  }
  if (applied) line(paint("dim", "  已载入 .env（" + applied + " 项）"));
  return applied > 0;
}

/* ------------------------------------------------------------------ *
 * 端口探测
 * ------------------------------------------------------------------ */
function isFreePort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(start) {
  for (let p = start; p < start + PORT_SCAN; p++) {
    if (await isFreePort(p)) return p;
  }
  return start;   // 交由 server.js 自己的 error 处理
}

/* ------------------------------------------------------------------ *
 * 健康检查（Node 原生 http 直连，不受 HTTP_PROXY 影响）
 * ------------------------------------------------------------------ */
function healthOf(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/healthz", timeout: HEALTH_TIMEOUT, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            resolve(j && j.service === SERVICE_NAME ? j : null);
          } catch (e) { resolve(null); }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/** 在候选端口区间里找出本工具真正监听的端口 */
async function findLivePort(start) {
  for (let p = start; p < start + PORT_SCAN; p++) {
    const h = await healthOf(p);
    if (h) return { port: p, health: h };
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 浏览器
 * ------------------------------------------------------------------ */
function openBrowser(url) {
  try {
    if (process.platform === "win32") exec('start "" "' + url + '"');
    else if (process.platform === "darwin") exec('open "' + url + '"');
    else exec('xdg-open "' + url + '"');
    return true;
  } catch (e) { return false; }
}

/* ------------------------------------------------------------------ *
 * PID / 端口记录
 *
 * 可能同时存在多个实例（前台 + 后台，或不同端口），因此用数组记录，
 * 不能只存一条 —— 否则后启动的会覆盖先启动的，stop/status 会漏实例。
 * ------------------------------------------------------------------ */
function readRecords() {
  let raw = null;
  try { raw = fs.readFileSync(PID_FILE, "utf8").trim(); } catch (e) { }
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j.filter((r) => r && r.pid);
    if (j && j.pid) return [j];              // 兼容旧版单条格式
  } catch (e) {
    const pid = Number(raw);                 // 兼容最早的纯数字格式
    if (Number.isInteger(pid) && pid > 0) return [{ pid, port: readPortFile(), mode: "unknown" }];
  }
  return [];
}

function writeRecords(list) {
  try {
    if (!list.length) { fs.unlinkSync(PID_FILE); return; }
    fs.writeFileSync(PID_FILE, JSON.stringify(list));
  } catch (e) { }
}

function upsertRecord(rec) {
  const list = readRecords().filter((r) => r.pid !== rec.pid);
  list.push(rec);
  writeRecords(list);
}

function removeRecord(pid) {
  writeRecords(readRecords().filter((r) => r.pid !== pid));
}

function readPortFile() {
  try {
    const p = Number(fs.readFileSync(PORT_FILE, "utf8").trim());
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch (e) { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

/**
 * 按监听端口反查进程 PID —— 用于"有实例在跑但没有 PID 记录"的孤儿场景。
 * Windows 用 netstat，Linux/macOS 用 lsof；查不到就返回 null。
 */
function findPidByPort(port) {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32"
      ? "netstat -ano -p TCP"
      : "lsof -nP -iTCP:" + port + " -sTCP:LISTEN -t";
    exec(cmd, { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      if (process.platform === "win32") {
        // 形如  TCP  127.0.0.1:8657  0.0.0.0:0  LISTENING  12345
        const rows = stdout.split(/\r?\n/).filter((l) => l.includes("LISTENING"));
        for (const row of rows) {
          const parts = row.trim().split(/\s+/);
          const local = parts[1] || "";
          const pid = Number(parts[parts.length - 1]);
          if (/:(\d+)$/.exec(local) && Number(/:(\d+)$/.exec(local)[1]) === port && pid > 0) {
            resolve(pid); return;
          }
        }
        resolve(null);
      } else {
        const pid = Number(stdout.trim().split(/\s+/)[0]);
        resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * 状态查询
 * ------------------------------------------------------------------ */
async function currentStatus() {
  const startPort = Number(argValue("--port")) || Number(process.env.PORT) || DEFAULT_PORT;
  const records = readRecords();

  // 收集候选端口：记录里的 + 默认区间 + 常见偏移
  const candidates = [];
  const push = (p) => { if (p && !candidates.includes(p)) candidates.push(p); };
  records.forEach((r) => push(r.port));
  push(readPortFile());
  for (let p = startPort; p < startPort + PORT_SCAN; p++) push(p);

  const live = [];
  const seen = new Set();
  for (const p of candidates) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const h = await healthOf(p);
    if (h) live.push({ port: p, health: h });
  }
  live.sort((a, b) => a.port - b.port);

  // 关联 PID 记录
  for (const inst of live) {
    const rec = records.find((r) => r.port === inst.port);
    inst.record = rec || null;
  }
  return { instances: live, records };
}

function showStatus(st) {
  banner("运行状态");
  if (!st.instances.length) {
    line("  " + paint("yellow", "○ 未运行"));
    // 顺手清理已失效的 PID 记录，避免状态里长期挂着"残留"提示
    const stale = st.records.filter((r) => !pidAlive(r.pid));
    if (stale.length) {
      writeRecords(st.records.filter((r) => pidAlive(r.pid)));
      line(paint("dim", "    已清理 " + stale.length + " 条失效记录"));
    }
    line();
    return false;
  }
  st.instances.forEach((inst, i) => {
    const mins = Math.floor((inst.health.uptime || 0) / 60);
    line("  " + paint("green", "● 运行中") + (st.instances.length > 1 ? paint("dim", "（第 " + (i + 1) + " 个）") : ""));
    line("    界面地址：" + paint("cyan", "http://localhost:" + inst.port));
    line("    健康检查：" + paint("dim", "http://localhost:" + inst.port + "/healthz"));
    line("    版本：" + inst.health.version + paint("dim", "   运行时长：" + mins + " 分钟"));
    line("    模式：" + (inst.health.mode === "multi-user" ? "多用户" : "单用户"));
    if (inst.record && inst.record.pid) {
      line("    PID：" + inst.record.pid + paint("dim", "（" + (inst.record.mode === "bg" ? "后台" : "前台") + "）"));
    }
    line();
  });
  if (st.instances.length > 1) {
    line(paint("dim", "  提示：存在多个实例，执行 stop 可全部停止。"));
    line();
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 停止
 * ------------------------------------------------------------------ */
async function stopService() {
  banner("停止服务");
  const records = readRecords();
  const alive = records.filter((r) => pidAlive(r.pid));
  const stale = records.filter((r) => !pidAlive(r.pid));

  if (!alive.length) {
    // 没有可杀的进程，但可能存在"无 PID 记录"的实例（记录被覆盖/清掉等）
    const st = await currentStatus();
    if (st.instances.length) {
      line(paint("yellow", "! 检测到 " + st.instances.length + " 个运行中实例，但缺少 PID 记录，尝试按端口反查…"));
      const recovered = [];
      for (const inst of st.instances) {
        const pid = await findPidByPort(inst.port);
        if (pid && pidAlive(pid)) {
          recovered.push({ pid, port: inst.port, mode: "orphan" });
          try { process.kill(pid, "SIGTERM"); } catch (e) { }
          line("  → 端口 " + inst.port + " → PID " + pid + "，已发送停止信号");
        } else {
          line(paint("yellow", "  → 端口 " + inst.port + " 无法反查 PID，请手动关闭对应终端窗口"));
          line("     或执行：taskkill /F /IM node.exe");
        }
      }
      if (!recovered.length) {
        process.exitCode = 1;
        return;
      }
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (!recovered.some((r) => pidAlive(r.pid))) break;
      }
      const remain = recovered.filter((r) => pidAlive(r.pid));
      if (remain.length) {
        line(paint("yellow", "! 未在 6 秒内退出：" + remain.map((r) => "PID " + r.pid).join("、")));
        process.exitCode = 1;
      } else {
        line(paint("green", "✓ 已停止 " + recovered.length + " 个实例。"));
      }
      return;
    }
    if (stale.length) {
      line(paint("yellow", "· " + stale.length + " 条残留记录（进程已不存在），已清理。"));
      writeRecords([]);
    }
    line(paint("green", "✓ 没有正在运行的服务。"));
    return;
  }

  line("发现 " + alive.length + " 个运行中实例，正在停止…");
  for (const rec of alive) {
    try { process.kill(rec.pid, "SIGTERM"); } catch (e) { }
    line("  → PID " + rec.pid + (rec.port ? "（端口 " + rec.port + "）" : ""));
  }

  let stopped = 0;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const remain = alive.filter((r) => pidAlive(r.pid));
    if (!remain.length) { stopped = alive.length; break; }
  }
  if (!stopped) {
    const remain = alive.filter((r) => pidAlive(r.pid));
    stopped = alive.length - remain.length;
    if (remain.length) {
      line(paint("yellow", "! 以下进程未在 6 秒内退出：" + remain.map((r) => r.pid).join("、")));
      line("  可执行：taskkill /F /PID " + remain.map((r) => r.pid).join(" "));
      process.exitCode = 1;
    }
  }
  if (stale.length) line(paint("dim", "  另清理 " + stale.length + " 条残留记录"));
  writeRecords([]);
  line(paint("green", "✓ 已停止 " + stopped + " 个实例。"));
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
function showInfo(port, mode) {
  const url = "http://localhost:" + port;
  line();
  line("  " + paint("green", "● ") + paint("bold", "EVE 辅助工具已启动"));
  line("    界面地址：" + paint("cyan", url));
  line("    健康检查：" + paint("dim", url + "/healthz"));
  line("    运行模式：" + (mode === "multi" ? "多用户（需注册登录）" : "单用户（个人日常使用）"));
  line("    数据目录：" + paint("dim", path.join(USER_DIR, "users", "local")));
  line();
  if (!process.env.EVE_CLIENT_ID) {
    const cfgFile = path.join(USER_DIR, "eve_config_v1.json");
    let has = false;
    try { has = !!JSON.parse(fs.readFileSync(cfgFile, "utf8")).clientId; } catch (e) { }
    if (!has) {
      line(paint("yellow", "  提示：尚未配置 Client ID —— 打开界面后到「设置」页填写，才能进行角色授权。"));
      line(paint("dim", "        （欧服与国服各需一个 Client ID，回调地址 http://localhost:" + port + "/sso/callback）"));
      line();
    }
  }
  line(paint("dim", "  停止服务：在本窗口按 Ctrl+C" + (FLAGS.background ? "（或执行 stop 命令）" : "")));
  line();
}

/** 等待服务真正起来（最多 30 秒） */
async function waitForLive(startPort) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const live = await findLivePort(startPort);
    if (live) return live;
  }
  return null;
}

async function startService(background) {
  const useBg = background === undefined ? FLAGS.background : background;
  banner(useBg ? "后台启动" : "前台启动");
  loadEnvFile();

  const startPort = Number(argValue("--port")) || Number(process.env.PORT) || DEFAULT_PORT;
  const explicitPort = !!argValue("--port");

  // 已在运行？直接开浏览器
  // 注：显式指定 --port 时允许再起一个实例（多开不同端口）
  const existing = await findLivePort(startPort);
  if (existing && !explicitPort) {
    line(paint("green", "● EVE 辅助工具已在运行（端口 " + existing.port + "），直接打开界面。"));
    if (!FLAGS.noBrowser) openBrowser("http://localhost:" + existing.port);
    line();
    return;
  }

  const port = await pickPort(startPort);
  const env = Object.assign({}, process.env, { PORT: String(port) });
  if (FLAGS.multiUser) env.EVE_MULTI_USER = "1";

  if (useBg) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const logFile = path.join(LOG_DIR,
      "server-" + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) +
      "-" + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + ".log");
    const fd = fs.openSync(logFile, "a");
    const child = spawn(process.execPath, [SERVER_JS], {
      cwd: ROOT, env, detached: true, stdio: ["ignore", fd, fd], windowsHide: true
    });
    child.unref();
    upsertRecord({ pid: child.pid, port, mode: "bg", logFile, startedAt: Date.now() });
    line(paint("dim", "  后台运行中，PID " + child.pid + "，日志：" + path.relative(ROOT, logFile)));

    const live = await waitForLive(startPort);
    if (!live) {
      line(paint("red", "✗ 启动后未能通过健康检查，请查看日志文件。"));
      process.exitCode = 1;
      return;
    }
    upsertRecord({ pid: child.pid, port: live.port, mode: "bg", logFile, startedAt: Date.now() });
    showInfo(live.port, env.EVE_MULTI_USER === "1" ? "multi" : "single");
    if (!FLAGS.noBrowser) openBrowser("http://localhost:" + live.port);
    return;
  }

  // ---------- 前台 ----------
  line(paint("dim", "  正在启动…（端口 " + port + "）"));
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"]
  });
  upsertRecord({ pid: child.pid, port, mode: "fg", startedAt: Date.now() });

  const forward = (sig) => { try { child.kill(sig); } catch (e) { } };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", (code, sig) => {
    removeRecord(child.pid);
    line();
    line(paint("dim", "  服务已停止（" + (sig ? "信号 " + sig : "退出码 " + code) + "）。"));
    process.exit(code === null ? 0 : code);
  });

  const live = await waitForLive(startPort);
  if (live) {
    upsertRecord({ pid: child.pid, port: live.port, mode: "fg", startedAt: Date.now() });
    showInfo(live.port, env.EVE_MULTI_USER === "1" ? "multi" : "single");
    if (!FLAGS.noBrowser) openBrowser("http://localhost:" + live.port);
  }
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */
function latestLogFile() {
  const records = readRecords();
  // 取最近一条带日志文件的记录
  const withLog = records.filter((r) => r.logFile && fs.existsSync(r.logFile))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (withLog.length) return withLog[0].logFile;
  try {
    const files = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith(".log")).sort();
    if (files.length) return path.join(LOG_DIR, files[files.length - 1]);
  } catch (e) { }
  return null;
}

function showLogs() {
  banner("最近日志");
  const f = latestLogFile();
  if (!f) {
    line(paint("yellow", "· 暂无日志文件（后台模式启动后会在 用户数据/logs/ 生成）。"));
    line();
    return;
  }
  line(paint("dim", "  文件：" + path.relative(ROOT, f)));
  const text = fs.readFileSync(f, "utf8").split(/\r?\n/);
  const tail = text.slice(-40);
  line();
  for (const t of tail) line("  " + t);
  line();
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */
function runTests() {
  banner("自检测试");
  // 注意：node a.js b.js 只会执行 a.js，b.js 被当作参数传入 —— 必须逐个串行执行
  const cmds = [
    "src/core/skills.test.js",
    "src/core/m2.test.js",
    "src/core/auth-callback.test.js",
    "src/core/user-store.test.js",
    "src/core/server-routes.test.js",
    "src/data/store.test.js",
    "src/ui/calc-core.test.js"
  ];

  (async () => {
    let failed = 0;
    for (const c of cmds) {
      line(paint("dim", "  ── " + c));
      const code = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(ROOT, c)], {
          cwd: ROOT, stdio: "inherit"
        });
        child.on("exit", (rc) => resolve(rc === null ? 1 : rc));
      });
      if (code !== 0) { failed++; line(paint("red", "  ✗ " + c + " 失败（退出码 " + code + "）")); }
    }
    line();
    line(failed === 0
      ? paint("green", "✓ 离线测试全部通过（" + cmds.length + " 个测试文件）")
      : paint("red", "✗ " + failed + " / " + cmds.length + " 个测试文件失败"));
    process.exitCode = failed === 0 ? 0 : 1;
  })();
}

/* ------------------------------------------------------------------ *
 * 仅打开浏览器
 * ------------------------------------------------------------------ */
async function openOnly() {
  const st = await currentStatus();
  if (!st.instances.length) {
    banner("打开界面");
    line(paint("yellow", "· 服务未运行，请先执行 start。"));
    line();
    return;
  }
  const inst = st.instances[0];
  const url = "http://localhost:" + inst.port;
  openBrowser(url);
  line(paint("green", "✓ 已打开 ") + url);
  if (st.instances.length > 1) {
    line(paint("dim", "  另有实例在端口 " + st.instances.slice(1).map((i) => i.port).join("、")));
  }
}

/* ------------------------------------------------------------------ *
 * 交互菜单
 * ------------------------------------------------------------------ */
function printMenu() {
  banner("本地控制台");
  line("  " + paint("bold", "1") + ". 启动服务（前台，Ctrl+C 停止）");
  line("  " + paint("bold", "2") + ". 启动服务（后台，终端可关）");
  line("  " + paint("bold", "3") + ". 停止服务");
  line("  " + paint("bold", "4") + ". 重启服务（后台模式）");
  line("  " + paint("bold", "5") + ". 查看状态");
  line("  " + paint("bold", "6") + ". 打开界面");
  line("  " + paint("bold", "7") + ". 查看最近日志");
  line("  " + paint("bold", "8") + ". 运行自检测试");
  line("  " + paint("bold", "0") + ". 退出");
  line();
}

async function menu() {
  if (!process.stdin.isTTY && !FLAGS.pipe) {
    line("非交互终端，请直接指定命令：start | bg | stop | restart | status | open | logs | test");
    line("（或加 --pipe 以从标准输入读取菜单选择）");
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // 管道输入耗尽时 readline 会关闭，视为"结束菜单"
  rl.on("close", () => { line(); });
  const ask = (q) => new Promise((resolve) => {
    if (rl.closed) { resolve("0"); return; }
    let answered = false;
    rl.question(q, (a) => { answered = true; resolve(a); });
    rl.once("close", () => { if (!answered) resolve("0"); });
  });

  for (;;) {
    printMenu();
    const ans = (await ask("  请选择 [1-8, 0=退出]：")).trim();

    if (ans === "0" || ans === "") { rl.close(); line(); return; }

    switch (ans) {
      case "1": rl.close(); await startService(false); return;
      case "2": rl.close(); await startService(true); return;
      case "3": rl.close(); await stopService(); return;
      case "4": {
        rl.close();
        banner("重启服务");
        await stopService();
        await startService(true);
        return;
      }
      case "5": {
        const st = await currentStatus();
        showStatus(st);
        break;
      }
      case "6": await openOnly(); break;
      case "7": showLogs(); break;
      case "8": rl.close(); runTests(); return;
      default:
        line(paint("yellow", "  无效选项，请输入 0-8。"));
        line();
    }
  }
}

/* ------------------------------------------------------------------ *
 * 帮助
 * ------------------------------------------------------------------ */
function showHelp() {
  line("EVE 辅助工具 —— 本地控制台");
  line();
  line("  node scripts/launch.js [命令] [选项]");
  line();
  line("  命令：");
  line("    start      前台启动（Ctrl+C 停止）");
  line("    bg         后台启动（终端可关，日志写入 用户数据/logs/）");
  line("    stop       停止服务");
  line("    restart    重启（后台模式）");
  line("    status     查看运行状态");
  line("    open       仅打开浏览器界面");
  line("    logs       查看最近日志");
  line("    test       运行离线自检测试");
  line("    menu       交互菜单（默认）");
  line();
  line("  选项：");
  line("    --port <n>    起始端口，被占用时自动顺延");
  line("    --multi-user  启用多用户模式");
  line("    --no-browser  不自动打开浏览器");
  line();
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  if (FLAGS.help) { showHelp(); return; }

  checkNodeVersion();
  checkAssets();

  switch (command) {
    case "start": return startService(false);
    case "bg": return startService(true);
    case "stop": return stopService();
    case "restart":
      banner("重启服务");
      await stopService();
      return startService(true);
    case "status": {
      const st = await currentStatus();
      showStatus(st);
      return;
    }
    case "open": return openOnly();
    case "logs": return showLogs();
    case "test": return runTests();
    case "menu":
    default: return menu();
  }
}

main().catch((e) => {
  console.error(paint("red", "✗ 执行失败：") + (e && e.message ? e.message : e));
  process.exit(1);
});
