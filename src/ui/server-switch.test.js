/*
 * 左上角「服务器切换」逻辑测试
 *
 * 用法：node src/ui/server-switch.test.js
 *
 * 覆盖：
 *   1. 三服兜底表与 src/core/servers.js 保持一致
 *   2. 列表归一化（缺字段 / 去重 / 空列表 / 未知服）
 *   3. 持久化读写与隐私模式降级
 *   4. 切换决策 plan()：未知服 / 点当前服 / 正常切换 / 跨服角色
 *   5. 浏览器 vm 加载：确认 window.EveServerSwitch 可用（首屏不依赖接口）
 *   6. 源码回归断言：禁止再出现 button.text 比高亮、禁止把绑定挂进
 *      loadConfig().then()（那会导致打开页面时点不动）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log("  OK   " + label + (detail ? "  → " + detail : "")); }
  else { fail++; console.log("  FAIL " + label + (detail ? "  → " + detail : "")); }
}
function section(t) { console.log("\n【" + t + "】"); }

const ROOT = path.join(__dirname, "..", "..");
const SS = require("./server-switch.js");
const CORE = require(path.join(ROOT, "src", "core", "servers.js"));
const appSrc = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/* ------------------------------------------------------------------ */
section("兜底表与服务端定义一致");
{
  const fb = SS.FALLBACK_SERVERS;
  ok(fb.length === 3, "内置三服兜底表", fb.map(s => s.key).join("/"));
  ok(JSON.stringify(fb.map(s => s.key)) === JSON.stringify(CORE.SERVER_ORDER),
    "顺序与 SERVER_ORDER 一致", CORE.SERVER_ORDER.join("/"));
  fb.forEach(s => {
    const c = CORE.SERVERS[s.key];
    ok(!!c, "兜底表含 " + s.key);
    ok(s.label === c.label, s.key + " 全称一致", s.label);
    ok(s.short === c.short, s.key + " 简称一致", s.short);
  });
}

/* ------------------------------------------------------------------ */
section("服务器列表归一化");
{
  const empty = SS.normalizeServers([]);
  ok(empty.length === 3 && empty[0].key === "serenity", "空列表回落兜底表");
  ok(SS.normalizeServers(null).length === 3, "null 回落兜底表");

  const partial = SS.normalizeServers([
    { key: "serenity" },
    { key: "shuguang", label: "自定义名" },
    { key: "serenity", label: "重复项" },
    { key: "newserver", label: "未来新增服" },
    null,
    { label: "缺 key" }
  ]);
  ok(partial.length === 3, "去重并丢弃无 key 项", partial.map(s => s.key).join("/"));
  ok(partial[0].label === "国服 经典服（晨曦）", "缺 label 时补齐");
  ok(partial[0].short === "晨曦", "缺 short 时补齐");
  ok(partial[1].label === "自定义名", "服务端 label 优先保留");
  ok(partial[1].short === "曙光", "缺 short 但已知服仍补齐");
  ok(partial[2].key === "newserver" && partial[2].short === "未来新增服",
    "未知服不丢弃，short 回落到 label");
}

section("查询辅助函数");
{
  const list = SS.normalizeServers(null);
  ok(SS.isKnown(list, "tranquility"), "isKnown 认识欧服");
  ok(!SS.isKnown(list, "not-a-server"), "isKnown 拒绝未知服");
  ok(SS.labelOf(list, "shuguang") === "国服 曙光服", "labelOf");
  ok(SS.shortOf(list, "serenity") === "晨曦", "shortOf");
  ok(SS.labelOf(list, "unknown") === "unknown", "未知 key 原样返回");
}

/* ------------------------------------------------------------------ */
section("按钮高亮映射（点击后必须立刻指向所选服）");
{
  const list = SS.normalizeServers(null);
  const m0 = SS.highlightMap(list, "serenity");
  ok(m0.serenity === true && m0.shuguang === false && m0.tranquility === false,
    "晨曦为当前服时只有晨曦高亮");
  const m1 = SS.highlightMap(list, "tranquility");
  ok(m1.serenity === false && m1.shuguang === false && m1.tranquility === true,
    "切到欧服后高亮必须立刻转到欧服");
  const m2 = SS.highlightMap(list, "old_server");
  ok(!m2.serenity && !m2.shuguang && !m2.tranquility, "当前服非法时不高亮任何按钮");
  ok(Object.keys(m1).length === 3, "映射覆盖全部按钮");
}

section("初始服务器与持久化");
{
  const list = SS.normalizeServers(null);
  ok(SS.resolveInitialServer(null, list) === "serenity", "无保存值 → 默认晨曦");
  ok(SS.resolveInitialServer("tranquility", list) === "tranquility", "合法保存值生效");
  ok(SS.resolveInitialServer("old_server", list) === "serenity", "失效保存值回落默认");
  ok(SS.resolveInitialServer("shuguang", [{ key: "shuguang" }], "serenity") === "shuguang",
    "默认值不在列表时回落到第一个合法服");

  const mem = {
    _v: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
    setItem(k, v) { this._v[k] = String(v); }
  };
  ok(SS.readSaved(mem) === null, "初次读取为空");
  ok(SS.save(mem, "shuguang") === true, "保存成功");
  ok(mem._v[SS.STORAGE_KEY] === "shuguang", "写入正确的 key");
  ok(SS.readSaved(mem) === "shuguang", "读回一致");
  ok(SS.resolveInitialServer(SS.readSaved(mem), list) === "shuguang", "刷新后仍停在用户所选服");

  ok(SS.save(null, "serenity") === false, "无 storage 时静默失败");
  ok(SS.save(mem, "") === false, "拒绝写空值");
  const hostile = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("SecurityError"); }
  };
  ok(SS.readSaved(hostile) === null, "隐私模式读取不抛异常");
  ok(SS.save(hostile, "serenity") === false, "隐私模式写入不抛异常");
}

/* ------------------------------------------------------------------ */
section("切换决策 plan()");
{
  const list = SS.normalizeServers(null);

  const bad = SS.plan("serenity", "not-a-server", list, null);
  ok(bad.ok === false && bad.reason === "unknown", "未知服被拒绝");
  ok(bad.key === "serenity", "拒绝时保持当前服不变");
  ok(bad.clearCaches === false, "拒绝时不清缓存");

  const same = SS.plan("serenity", "serenity", list, "serenity");
  ok(same.ok === true && same.changed === false, "点当前已选中的服 → 不重复重绘");
  ok(same.clearCaches === false, "无需清缓存");

  const sw = SS.plan("serenity", "tranquility", list, null);
  ok(sw.ok === true && sw.changed === true, "正常切换");
  ok(sw.key === "tranquility", "目标服正确");
  ok(sw.clearCaches === true, "切服必须清缓存（三服数据隔离）");
  ok(sw.charMismatch === false, "无角色时不涉及跨服");

  const sameChar = SS.plan("serenity", "shuguang", list, "shuguang");
  ok(sameChar.charMismatch === false, "角色已是目标服 → 不提示跨服");

  const cross = SS.plan("serenity", "shuguang", list, "serenity");
  ok(cross.charMismatch === true, "角色属于别服 → 标记跨服，需换档案或清空");

  const custom = SS.normalizeServers([{ key: "newserver", label: "未来服" }]);
  const cs = SS.plan("serenity", "newserver", custom, null);
  ok(cs.ok === true && cs.key === "newserver", "服务端新增服也能切换（不被兜底表写死）");
}

/* ------------------------------------------------------------------ */
section("浏览器侧全局导出（首屏不依赖 /api/config）");
{
  const src = fs.readFileSync(path.join(__dirname, "server-switch.js"), "utf8");
  const sandbox = { console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const B = sandbox.EveServerSwitch;
  ok(!!B, "window.EveServerSwitch 已导出");
  ok(B && typeof B.plan === "function" && typeof B.normalizeServers === "function",
    "浏览器版导出完整 API");
  ok(B && B.normalizeServers(null).length === 3, "浏览器版无需接口即可拿到三服");
}

/* ------------------------------------------------------------------ */
section("前端绑定回归断言（防止「点了没反应」复现）");
{
  ok(/<script src="src\/ui\/server-switch\.js"><\/script>/.test(htmlSrc),
    "index.html 在 app.js 之前引入 server-switch.js");
  ok(htmlSrc.indexOf("server-switch.js") < htmlSrc.indexOf('src="src/ui/app.js"'),
    "加载顺序正确");

  ok(appSrc.indexOf("var SS = window.EveServerSwitch;") >= 0, "app.js 引用了切换模块");
  ok(/function renderServerSelector\(\)/.test(appSrc), "存在独立渲染函数");
  ok(/"data-server": sv.key/.test(appSrc), "按钮带 data-server 标识");
  ok(/SS\.highlightMap\(S\.servers, S\.server\)/.test(appSrc),
    "高亮状态由纯函数统一计算");
  ok(/!!map\[b\.dataset\.server\]/.test(appSrc), "按钮按 data-server 查表决定高亮");
  const swStart = appSrc.indexOf("function switchServer(key) {");
  const swEnd = appSrc.indexOf("/* ================================================================", swStart);
  const swBody = appSrc.slice(swStart, swEnd > 0 ? swEnd : undefined);
  ok(swBody.indexOf("S.server = p.key") >= 0 &&
    swBody.indexOf("S.server = p.key") < swBody.indexOf("syncServerButtons();"),
    "★ 先赋值 S.server 再同步高亮（顺序反了会高亮滞后一服）");
  ok(!/b\.text === sv\.short/.test(appSrc),
    "已移除 button.text 比对（HTMLButtonElement 无 text 属性）");
  ok(!/\.classList\.toggle\("on",\s*b\.text/.test(appSrc),
    "不存在任何基于 .text 的高亮判断");

  const initBody = appSrc.slice(appSrc.indexOf("function init() {"));
  ok(initBody.indexOf("renderServerSelector()") >= 0 &&
    initBody.indexOf("renderServerSelector()") < initBody.indexOf("事件绑定"),
    "init() 一开始就渲染按钮，不等配置接口");

  ok(/SS\.save\(localStore\(\), p\.key\)/.test(appSrc), "切换后持久化所选服");
  ok(/var fn = PAGE_INIT\[S\.page\]/.test(appSrc), "切换后重绘当前页");
  ok(/p\.clearCaches/.test(appSrc), "切换后清理按服缓存");
  ok(/p\.charMismatch/.test(appSrc), "处理跨服角色档案");
  ok(/SS\.plan\(/.test(appSrc), "切换走统一决策函数");
  ok(/加载配置失败（服务器切换仍可用内置列表）/.test(appSrc),
    "配置接口失败时切换控件仍可用");
  ok(/var sameShape/.test(appSrc) && /if \(sameShape\) \{ syncServerButtons\(\); return; \}/.test(appSrc),
    "列表未变时只同步高亮，避免配置返回瞬间打断点击");
  ok(/function startAuth\(serverKey\)[\s\S]{0,300}serverKey !== S\.server/.test(appSrc),
    "授权目标服自动对齐左上角选中服，避免回调后错位");
}

console.log("\n" + "=".repeat(52));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
process.exit(fail > 0 ? 1 : 0);
