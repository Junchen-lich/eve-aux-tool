/**
 * 端到端验证监听器
 *
 * 等待用户完成网易账号登录与授权 → 观察：
 *   1. 回调是否到达本地（/sso/callback）
 *   2. 令牌是否成功交换并落盘
 *   3. 能否用该令牌拉取真实技能数据
 *   4. 技能是否正确映射为中文
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const TOKEN_FILE = path.join(ROOT, "用户数据", "eve_auth_v1.json");
const PROFILE_FILE = path.join(ROOT, "用户数据", "eve_char_profiles_v1.json");
const BASE = "http://127.0.0.1:8657";

function log(s) { process.stdout.write(s + "\n"); }

async function check() {
  // 1. 令牌文件
  if (!fs.existsSync(TOKEN_FILE)) {
    return { state: "waiting", msg: "等待授权完成（令牌文件尚未生成）" };
  }
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch (e) {
    return { state: "error", msg: "令牌文件解析失败：" + e.message };
  }
  const keys = Object.keys(tokens);
  if (!keys.length) {
    return { state: "waiting", msg: "令牌文件已创建但为空" };
  }

  const rec = tokens[keys[0]];
  log("\n=== ★ 令牌已落盘 ===");
  log("  key:          " + keys[0]);
  log("  serverKey:    " + rec.serverKey);
  log("  characterId:  " + rec.characterId);
  log("  characterName:" + (rec.characterName || "(无)"));
  log("  expiresAt:    " + (rec.expiresAt ? new Date(rec.expiresAt).toISOString() : "(无)"));
  log("  refreshToken: " + (rec.refreshToken ? "有" : "无"));

  // 2. 用令牌拉真实技能
  const skillMap = require(path.join(ROOT, "src", "core", "skill-map.js"));
  const url = BASE + "/esi/" + rec.serverKey + "/characters/" + rec.characterId + "/skills/";
  log("\n=== 拉取技能数据 ===");
  log("  " + url);

  const resp = await fetch(url, {
    headers: { Authorization: "Bearer " + rec.accessToken }
  });
  log("  HTTP " + resp.status);
  const text = await resp.text();
  if (!resp.ok) {
    log("  响应: " + text.slice(0, 300));
    return { state: "error", msg: "技能拉取失败 HTTP " + resp.status };
  }

  let data;
  try { data = JSON.parse(text); } catch (e) {
    log("  解析失败: " + text.slice(0, 200));
    return { state: "error", msg: "技能响应非 JSON" };
  }
  const skills = data.skills || [];
  log("  技能条目: " + skills.length);
  log("  total_sp:  " + data.total_sp);

  // 3. 映射为中文
  log("\n=== 技能映射（后台 typeID → 前台中文）===");
  let mapped = 0, unmapped = 0;
  const byId = skillMap.byId || skillMap.SM && skillMap.SM.byId;
  for (const s of skills) {
    const def = byId ? byId(s.skill_id) : null;
    if (def && def.nameZh) {
      mapped++;
      log("  " + String(s.skill_id).padEnd(7) + " Lv" + String(s.level).padEnd(3) + " → " + def.nameZh + "（" + def.nameEn + "）");
    } else {
      unmapped++;
      log("  " + String(s.skill_id).padEnd(7) + " Lv" + String(s.level).padEnd(3) + " → (未收录技能)");
    }
  }
  log("\n  已映射中文: " + mapped + " / 未收录: " + unmapped);

  // 4. 档案落盘检查
  if (fs.existsSync(PROFILE_FILE)) {
    const prof = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
    const pkey = rec.serverKey + ":" + rec.characterId;
    const p = prof.profiles ? prof.profiles[pkey] : null;
    log("\n=== 角色档案 ===");
    log("  档案文件存在，条目数: " + (prof.profiles ? Object.keys(prof.profiles).length : 0));
    if (p) {
      log("  匹配档案: " + pkey);
      log("  名称: " + (p.name || "(无)"));
      log("  技能等级条数: " + Object.keys(p.skills || {}).length);
      const levels = Object.entries(p.skills || {})
        .map(([k, v]) => k + "=" + v).join(", ");
      log("  技能等级: " + levels);
    } else {
      log("  ★ 未找到对应档案（需调用 /api/sync 触发同步）");
    }
  }

  return { state: "done", msg: "全链路验证完成" };
}

(async () => {
  let last = "";
  const tick = async () => {
    const r = await check();
    if (r.msg !== last) {
      last = r.msg;
      log("[" + new Date().toLocaleTimeString("zh-CN") + "] " + r.msg);
    }
    if (r.state === "done") {
      log("\n★ 端到端验证成功");
      process.exit(0);
    }
    if (r.state === "error") {
      log("\n✗ 验证失败：" + r.msg);
      process.exit(2);
    }
  };
  await tick();
  const timer = setInterval(tick, 2000);
  setTimeout(() => {
    clearInterval(timer);
    log("\n等待超时（30 分钟）");
    process.exit(3);
  }, 30 * 60 * 1000);
})();
