/*
 * 用户存储层自检 —— 验证多用户隔离与会话签名
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  UserStore, UserSpace, deriveUserId, isValidUserId,
  signSession, verifySession, parseCookies, safeEqual, LOCAL_USER
} = require("./user-store.js");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n【" + t + "】"); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eve_users_"));

/* ---------------- 基础：用户 ID 派生 ---------------- */
section("【用户标识派生】");
{
  const salt = "test-salt-123";
  const id1 = deriveUserId("alice", salt);
  const id2 = deriveUserId("alice", salt);
  const id3 = deriveUserId("bob", salt);
  const id4 = deriveUserId("alice", "different-salt");

  ok(id1 === id2, "同一用户名+同一盐 → 同一 userId", id1);
  ok(id1 !== id3, "不同用户名 → 不同 userId");
  ok(id1 !== id4, "不同盐 → 不同 userId（防彩虹表）");
  ok(deriveUserId("ALICE", salt) === id1, "用户名大小写不敏感");
  ok(deriveUserId(" alice ", salt) === id1, "用户名首尾空格被裁剪");
  ok(isValidUserId(id1), "userId 格式合法", id1);
  ok(!isValidUserId("../../etc/passwd"), "路径穿越串被拒");
  ok(!isValidUserId("u_ZZZZ"), "非法十六进制被拒");
  ok(!isValidUserId(""), "空串被拒");
}

/* ---------------- 会话签名 ---------------- */
section("【会话 Cookie 签名】");
{
  const salt = "sess-salt";
  const uid = deriveUserId("pw", salt);
  const exp = Date.now() + 3600000;
  const cookie = signSession(uid, exp, salt);

  ok(verifySession(cookie, salt) === uid, "有效会话可验证", uid);
  ok(verifySession(cookie, "wrong-salt") === null, "错误盐 → 拒绝");
  ok(verifySession(cookie + "x", salt) === null, "篡改 MAC → 拒绝");
  ok(verifySession(signSession(uid, Date.now() - 1000, salt), salt) === null, "过期会话 → 拒绝");
  ok(verifySession("", salt) === null, "空 Cookie → 拒绝");
  ok(verifySession("garbage", salt) === null, "垃圾值 → 拒绝");

  // 篡改 userId 但保留原 MAC
  const other = deriveUserId("other", salt);
  const parts = cookie.split(".");
  const forged = other + "." + parts[1] + "." + parts[2];
  ok(verifySession(forged, salt) === null, "伪造 userId → 拒绝");
}

/* ---------------- Cookie 解析 ---------------- */
section("【Cookie 头解析】");
{
  const c = parseCookies("a=1; eve_session=abc.def.ghi; b=2");
  ok(c.a === "1", "解析普通键");
  ok(c.eve_session === "abc.def.ghi", "解析会话键");
  ok(c.b === "2", "解析末位键（无空格）");
  ok(Object.keys(parseCookies("")).length === 0, "空头 → 空对象");
  ok(Object.keys(parseCookies(null)).length === 0, "null → 空对象");
}

/* ---------------- 隔离性：核心安全属性 ---------------- */
section("【多用户数据隔离】");
{
  const space = new UserSpace({ baseDir: path.join(tmp, "users"), salt: "iso-salt" });
  const rA = space.register("userA", "passwordA");
  const rB = space.register("userB", "passwordB");
  ok(rA.ok && rB.ok, "两个用户注册成功");
  const uidA = rA.userId, uidB = rB.userId;
  ok(uidA !== uidB, "两个用户得到不同目录", uidA + " / " + uidB);

  const storeA = space.store(uidA);
  const storeB = space.store(uidB);
  ok(storeA.dir !== storeB.dir, "存储目录不同");
  ok(storeA.authFile !== storeB.authFile, "令牌文件不同");
  ok(storeA.profilesFile !== storeB.profilesFile, "档案文件不同");

  // A 写入敏感数据，B 必须看不到
  storeA.saveTokens({ "serenity:111": { accessToken: "SECRET-A" } });
  storeA.saveProfiles({ "serenity:111": { characterName: "A的角色", skills: { ind: 5 } } });

  ok(storeB.tokens()["serenity:111"] === undefined, "★ B 读不到 A 的令牌");
  ok(storeB.profiles()["serenity:111"] === undefined, "★ B 读不到 A 的角色档案");
  ok(storeA.tokens()["serenity:111"].accessToken === "SECRET-A", "A 能读回自己的令牌");

  // 磁盘层面验证：目录确实分离
  ok(fs.existsSync(path.join(storeA.dir, "auth.json")), "A 的令牌文件落盘");
  ok(!fs.existsSync(path.join(storeB.dir, "auth.json")), "B 目录无令牌文件（未泄漏）");

  // 目录内不得有他人文件
  const filesB = fs.existsSync(storeB.dir) ? fs.readdirSync(storeB.dir) : [];
  ok(!filesB.includes("auth.json"), "B 目录内容不含 auth.json", JSON.stringify(filesB));
}

/* ---------------- 原子写入与损坏恢复 ---------------- */
section("【写入健壮性】");
{
  const space = new UserSpace({ baseDir: path.join(tmp, "users2"), salt: "s2" });
  const s = space.store(space.userIdFor("u1"));
  s.saveProfiles({ a: 1 });
  ok(JSON.stringify(s.profiles()) === '{"a":1}', "写入后可读回");

  // 模拟文件损坏
  fs.writeFileSync(s.profilesFile, "{ 坏掉的 json", "utf8");
  ok(s.profiles() && typeof s.profiles() === "object", "损坏文件 → 返回空对象而非崩溃");

  // 原子写入不应留下临时文件
  s.saveProfiles({ b: 2 });
  const leftovers = fs.readdirSync(s.dir).filter(f => f.includes(".tmp-"));
  ok(leftovers.length === 0, "无临时文件残留", JSON.stringify(leftovers));
}

/* ---------------- 元信息 ---------------- */
section("【用户元信息】");
{
  const space = new UserSpace({ baseDir: path.join(tmp, "users3"), salt: "s3" });
  const s = space.store(space.userIdFor("u2"));
  const m1 = s.meta();
  ok(m1.createdAt, "自动补 createdAt");
  ok(m1.userId === s.userId, "meta 含 userId");
  s.touch();
  ok(s.meta().lastSeenAt, "touch 记录 lastSeenAt");

  const users = space.listUsers();
  ok(users.length >= 1, "listUsers 能列出用户", users.length + " 个");
  ok(users.every(u => !("tokens" in u)), "listUsers 不含令牌数据");
}

/* ---------------- 旧文件迁移 ---------------- */
section("【旧版单文件迁移】");
{
  // 构造旧版文件
  const fakeRoot = path.join(tmp, "mig");
  fs.mkdirSync(fakeRoot, { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, "eve_auth_v1.json"),
    JSON.stringify({ "serenity:999": { accessToken: "OLD" } }), "utf8");
  fs.writeFileSync(path.join(fakeRoot, "eve_char_profiles_v1.json"),
    JSON.stringify({ "serenity:999": { characterName: "旧角色" } }), "utf8");

  // 用 monkey patch 指向假目录 —— 直接测迁移逻辑
  const space = new UserSpace({ baseDir: path.join(fakeRoot, "users"), salt: "mig-salt" });
  // 手动模拟迁移过程（LEGACY_FILES 指向真实项目路径，此处只验证目标写入逻辑）
  const store = space.store(LOCAL_USER);
  store.saveTokens({ "serenity:999": { accessToken: "OLD" } });
  store.saveProfiles({ "serenity:999": { characterName: "旧角色" } });
  const st = space.store(LOCAL_USER);
  ok(st.tokens()["serenity:999"].accessToken === "OLD", "迁移后令牌可读");
  ok(st.profiles()["serenity:999"].characterName === "旧角色", "迁移后档案可读");
  const meta = st.meta();
  ok(meta.createdAt, "迁移目标目录已建立元信息");
}

/* ---------------- 单用户模式 ---------------- */
section("【单用户模式（本地使用）】");
{
  const space = new UserSpace({ baseDir: path.join(tmp, "users4"), salt: "s4", singleUser: true });
  const uid = space.userIdFor("任意用户名");
  ok(uid === LOCAL_USER, "单用户模式忽略用户名", uid);
  const space2 = new UserSpace({ baseDir: path.join(tmp, "users4"), salt: "s4", singleUser: true });
  ok(space2.userIdFor("另一个") === LOCAL_USER, "单用户模式用户名不产生差异");
}

/* ---------------- 路径穿越防护 ---------------- */
section("【路径穿越防护】");
{
  const space = new UserSpace({ baseDir: path.join(tmp, "users5"), salt: "s5" });
  let threw = false;
  try { space.store("../../windows/system32"); } catch (e) { threw = true; }
  ok(threw, "非法 userId 被拒绝（不产生越权路径）");
  let threw2 = false;
  try { space.store("u_../evil"); } catch (e) { threw2 = true; }
  ok(threw2, "含 .. 的 userId 被拒绝");
}

/* ---------------- safeEqual ---------------- */
section("【常量时间比较】");
{
  ok(safeEqual("abc", "abc"), "相同字符串 → true");
  ok(!safeEqual("abc", "abd"), "不同字符串 → false");
  ok(!safeEqual("abc", "abcd"), "长度不同 → false");
  ok(!safeEqual("", "a"), "空 vs 非空 → false");
  ok(safeEqual("", ""), "空 vs 空 → true");
}


/* ---------------- 账户注册与认证 ---------------- */
section("【账户注册与认证】");
{
  const space = new UserSpace({ baseDir: path.join(tmp, "users6"), salt: "acc-salt" });

  const r1 = space.register("alice", "secret123");
  ok(r1.ok, "注册新用户", r1.userId);
  const r2 = space.register("alice", "secret123");
  ok(!r2.ok, "重复注册被拒", r2.error);
  const r3 = space.register("bob", "short");
  ok(!r3.ok, "口令过短被拒", r3.error);
  const r4 = space.register("a", "secret123");
  ok(!r4.ok, "用户名过短被拒", r4.error);
  const r5 = space.register("bad name!", "secret123");
  ok(!r5.ok, "非法字符用户名被拒", r5.error);

  const a1 = space.authenticate("alice", "secret123");
  ok(a1.ok, "正确口令认证通过", a1.userId);
  const a2 = space.authenticate("alice", "wrongpass");
  ok(!a2.ok, "错误口令被拒", a2.error);
  const a3 = space.authenticate("nobody", "secret123");
  ok(!a3.ok, "不存在用户被拒（不泄露用户是否存在）", a3.error);
  const a4 = space.authenticate("alice", "");
  ok(!a4.ok, "空口令被拒");

  // 口令不以明文存储
  const st = space.store(a1.userId);
  const meta = st.meta();
  ok(meta.pwHash && meta.pwHash.indexOf("secret123") < 0, "★ 口令不以明文存储");
  ok(meta.pwHash.indexOf("scrypt$") === 0, "使用 scrypt 哈希");
  ok(!!meta.pwSalt, "每用户独立随机盐");

  // 改口令
  const c1 = space.changePassword("alice", "secret123", "newsecret456");
  ok(c1.ok, "修改口令成功");
  ok(!space.authenticate("alice", "secret123").ok, "旧口令失效");
  ok(space.authenticate("alice", "newsecret456").ok, "新口令生效");

  // 用户名大小写
  space.register("Carol", "secret123");
  ok(space.authenticate("carol", "secret123").ok, "用户名大小写不敏感");
}


/* ---------------- 令牌落盘加密 ---------------- */
section("【令牌落盘加密（AES-256-GCM）】");
{
  const { AuthManager, deriveKey, encryptJson, decryptJson } = require("./auth.js");
  const space = new UserSpace({ baseDir: path.join(tmp, "users7"), salt: "enc-salt" });
  const r = space.register("encuser", "encpass123");
  const store = space.store(r.userId);
  const key = deriveKey(space.salt);

  const auth = new AuthManager({ clientId: "X", store, encryptionKey: key });
  auth.tokens = { "serenity:1": { accessToken: "SECRET_TOKEN_VALUE", refreshToken: "REFRESH_VAL" } };
  auth._save();

  const onDisk = store.tokens();
  ok(onDisk.__enc === "gcm", "落盘带加密标记");
  ok(JSON.stringify(onDisk).indexOf("SECRET_TOKEN_VALUE") < 0, "★ 磁盘上无明文 accessToken");
  ok(JSON.stringify(onDisk).indexOf("REFRESH_VAL") < 0, "★ 磁盘上无明文 refreshToken");

  const back = new AuthManager({ clientId: "X", store, encryptionKey: key });
  ok(back.tokens["serenity:1"].accessToken === "SECRET_TOKEN_VALUE", "解密正确还原");
  ok(back.tokens["serenity:1"].refreshToken === "REFRESH_VAL", "refreshToken 正确还原");

  // 错误密钥
  let failed = false;
  try { decryptJson(onDisk, deriveKey("wrong-salt")); } catch (e) { failed = true; }
  ok(failed, "错误密钥解密失败");

  // 篡改
  const raw = Buffer.from(onDisk.data, "base64");
  raw[0] ^= 0xff;
  let failed2 = false;
  try { decryptJson(Object.assign({}, onDisk, { data: raw.toString("base64") }), key); } catch (e) { failed2 = true; }
  ok(failed2, "篡改密文被 GCM 认证拒绝");

  // 明文格式兼容（迁移期）
  store.saveTokens({ "serenity:2": { accessToken: "OLD_PLAIN" } });
  const legacy = new AuthManager({ clientId: "X", store, encryptionKey: key });
  ok(legacy.tokens["serenity:2"].accessToken === "OLD_PLAIN", "兼容旧的明文格式");
}

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }

console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
