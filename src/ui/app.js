/*
 * EVE 辅助工具 —— 前端主逻辑
 * Copyright (C) 2026 Junchen-lich
 *
 * 模块划分：
 *   state      全局状态（角色、技能、服务器、缓存）
 *   api        与后端通信
 *   ui         通用渲染工具（金额格式化、表格、提示）
 *   page-char  角色与技能
 *   page-market市场行情
 *   page-ind   工业生产
 *   page-manuf 蓝图画廊与制造核算
 *   page-sell  挂单收益核算
 *   page-refine 矿石提炼
 *   page-set   设置
 *
 * 设计约束：
 *   - 计算一律走 window.EveCalc（与 Node 内核对照测试保证一致）
 *   - 物品只显示中文名，绝不暴露 typeID
 *   - 技能从 ESI 同步，手动修改仅作临时覆盖（刷新即恢复）
 */
(function () {
  "use strict";

  /* ================================================================ *
   * 状态
   * ================================================================ */
  var S = {
    server: "serenity",
    servers: [],
    char: null,          // { id, name, serverKey, skills:{}, ... }
    skills: {},          // 生效技能（来自角色，可被手动覆盖）
    skillOverride: {},   // 手动覆盖 { skillId: level }
    loaded: {},          // 数据表缓存
    fav: [],             // 收藏的物品中文名
    lastCalc: null,      // 上次制造核算结果
    pendingBp: null,     // 当前核算的蓝图
    marketCache: {},      // 行情缓存
    cfg: null,            // /api/config 返回（各服状态与回调地址）
    credentials: {},      // 各服已保存的 Client ID / Secret / 回调地址
    page: "char"          // 当前页面（switchPage 会更新）
  };

  /* ================================================================ *
   * 工具
   * ================================================================ */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (k === "class") n.className = attrs[k];
        else if (k === "html") n.innerHTML = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
      }
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  }

  /** 金额：2 位小数 + 千分位 */
  function isk(v) {
    if (v == null || !isFinite(v)) return "—";
    return Number(v).toLocaleString("zh-CN", {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  /** 数量：最多 2 位小数，无尾零 */
  function num(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    var d = digits == null ? 2 : digits;
    return Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d });
  }

  /** 百分比 */
  function pct(v, digits) {
    if (v == null || !isFinite(v)) return "—";
    return (v * 100).toFixed(digits == null ? 2 : digits) + "%";
  }

  function toast(msg, kind) {
    var t = el("div", { class: "toast " + (kind || ""), text: msg });
    $("#toasts").appendChild(t);
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transition = "opacity .3s";
      setTimeout(function () { t.remove(); }, 320);
    }, kind === "err" ? 5200 : 2800);
  }

  function status(elId, msg, kind) {
    var n = $("#" + elId);
    if (!n) return;
    n.innerHTML = "";
    if (!msg) return;
    n.appendChild(el("div", { class: "status " + (kind || ""), html: msg }));
  }

  function modal(title, bodyNode, buttons) {
    var m = $("#modal");
    m.innerHTML = "";
    m.appendChild(el("div", { class: "modal-hd" }, [
      el("span", { text: title }),
      el("span", { class: "spacer" }),
      el("button", { class: "btn sm", text: "关闭", onclick: closeModal })
    ]));
    m.appendChild(el("div", { class: "modal-bd" }, [bodyNode]));
    if (buttons && buttons.length) {
      m.appendChild(el("div", { class: "modal-ft" }, buttons));
    }
    $("#modalBg").classList.add("on");
  }
  function closeModal() { $("#modalBg").classList.remove("on"); }
  $("#modalBg").addEventListener("click", function (e) {
    if (e.target === this) closeModal();
  });

  /* ================================================================ *
   * 后端通信
   * ================================================================ */
  function api(path, opts) {
    opts = opts || {};
    var url = path;
    var init = { method: opts.method || "GET", headers: {} };
    if (opts.body) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(url, init).then(function (r) {
      return r.text().then(function (t) {
        var j;
        try { j = JSON.parse(t); } catch (e) { j = { ok: false, error: t.slice(0, 200) }; }
        if (!r.ok) {
          var err = new Error(j.error || ("HTTP " + r.status));
          err.status = r.status;
          err.payload = j;
          throw err;
        }
        return j;
      });
    });
  }

  /** ESI 代理（后端统一转发，携带用户令牌） */
  function esi(serverKey, path) {
    return api("/esi/" + serverKey + path);
  }

  /** 拉取静态数据表（带缓存） */
  function table(name) {
    if (S.loaded[name]) return Promise.resolve(S.loaded[name]);
    return fetch("data/sde/" + name + ".json").then(function (r) {
      if (!r.ok) throw new Error("数据表加载失败：" + name);
      return r.json();
    }).then(function (d) {
      S.loaded[name] = d;
      return d;
    });
  }

  /* ================================================================ *
   * 物品名称解析（中文优先，绝不暴露 typeID）
   * ================================================================ */
  function itemName(typeId) {
    var id = String(typeId);
    var names = S.loaded.item_names;
    if (names && names[id]) return names[id];
    var en = S.loaded.item_names_en;
    if (en && en[id]) return en[id];
    return "未收录物品";
  }

  /** 从中文名反查 typeID（用于行情查询） */
  function typeIdByName(name) {
    var names = S.loaded.item_names || {};
    var keys = Object.keys(names);
    for (var i = 0; i < keys.length; i++) {
      if (names[keys[i]] === name) return Number(keys[i]);
    }
    var en = S.loaded.item_names_en || {};
    keys = Object.keys(en);
    for (var j = 0; j < keys.length; j++) {
      if (en[keys[j]] === name) return Number(keys[j]);
    }
    return null;
  }

  /* ================================================================ *
   * 技能
   * ================================================================ */
  function effectiveSkills() {
    var out = {};
    for (var k in S.skills) out[k] = S.skills[k];
    for (var o in S.skillOverride) out[o] = S.skillOverride[o];
    return out;
  }

  var SKILL_LIST = [
    { id: "acct", name: "会计学", effect: "市场销售税每级 −11%（相对基础值）", group: "贸易" },
    { id: "broker_rel", name: "经纪人关系学", effect: "经纪费每级 −0.3%", group: "贸易" },
    { id: "ind", name: "工业理论", effect: "制造时间每级 −4%", group: "生产" },
    { id: "advind", name: "高级工业理论", effect: "所有制造与研究时间每级 −3%", group: "生产" },
    { id: "massprod", name: "批量生产学", effect: "同时制造槽每级 +1", group: "生产" },
    { id: "advmassprod", name: "高级量产技术", effect: "同时制造槽每级 +1（需批量生产学 V）", group: "生产" },
    { id: "lab", name: "实验室操作", effect: "同时研究/拷贝槽每级 +1", group: "生产" },
    { id: "advlab", name: "高级实验室技术", effect: "同时研究/拷贝槽每级 +1（需实验室操作 V）", group: "生产" },
    { id: "refine", name: "提炼学概论", effect: "精炼产出每级 +3%", group: "提炼" },
    { id: "refining", name: "提炼效率理论", effect: "精炼产出每级 +2%", group: "提炼" },
    { id: "sci", name: "科学", effect: "研究速度每级 +2%", group: "研究" },
    { id: "metal", name: "冶金学", effect: "金属产出每级 +2%", group: "生产" },
    { id: "res", name: "资源管理", effect: "每级 +1 个制造槽（需工业理论 IV）", group: "生产" },
    { id: "pi_customs", name: "报关代码专家", effect: "行星工业进出口税每级 −10%", group: "行星" }
  ];

  /* ================================================================ *
   * 页面：角色
   * ================================================================ */
  function renderChar() {
    var body = $("#charBody");
    body.innerHTML = "";

    if (!S.char) {
      body.appendChild(el("div", { class: "tip", html:
        "<b>尚未授权角色。</b>授权后工具会自动读取你的 14 项技能，" +
        "并代入税率、制造时间、槽位、提炼产出等全部核算公式 —— 无需手填任何技能数值。" +
        "<br>点击下方按钮选择服务器并授权。仅申请「读取角色技能」权限，不会访问你的资产与钱包。"
      }));

      /* ---- 方式一：标准授权（自注册应用）---- */
      body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:20px 0 8px", text: "方式一 · 标准授权（推荐，需自注册应用）" }));
      body.appendChild(el("div", { class: "tip", html:
        "在「设置」页填好该服的 Client ID 与回调地址后，点下方按钮走标准授权码流程，" +
        "授权完成后自动跳回本工具并同步技能。"
      }));
      var btns = el("div", { class: "row wrap", style: "margin-top:12px" });
      S.servers.forEach(function (sv) {
        btns.appendChild(el("button", {
          class: "btn pri",
          text: "授权 " + sv.label,
          onclick: function () { startAuth(sv.key); }
        }));
      });
      body.appendChild(btns);

      /* ---- 方式二：手动授权（网易官方公共 Client ID）---- */
      body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:26px 0 8px", text: "方式二 · 手动授权（无需注册应用）" }));
      body.appendChild(el("div", { class: "tip", html:
        "不想注册应用？用网易<b>官方公共 Client ID</b> 也能授权 —— " +
        "点「生成授权链接」，在浏览器里登录并同意后，把地址栏的整段地址粘回来即可。" +
        "<br>⚠ 此方式拿不到 refresh_token，令牌约 20 分钟过期；" +
        "<b>但已拉取的角色数据会长期保留在本地</b>，过期后技能参数依然可用，只需重新授权即可再次同步。"
      }));
      body.appendChild(el("div", { class: "row wrap", style: "margin-top:12px" }, [
        el("button", {
          class: "btn", text: "生成授权链接…",
          onclick: function () {
            try {
              openManualPanel("serenity");
              // 兜底：面板若未渲染出来，直接提示
              setTimeout(function () {
                if (!$("#charBody .card select")) {
                  console.error("手动授权面板未渲染");
                }
              }, 100);
            } catch (e) {
              console.error("打开手动授权面板失败：", e);
              status("charBody", '<div class="tip">打开手动授权面板失败：' +
                escapeHtml(e && e.message ? e.message : String(e)) + "</div>", "err");
            }
          }
        })
      ]));
      return;
    }

    /* 已授权 —— 展示技能 */
    var sk = effectiveSkills();
    var eff = window.EveCalc.skillEffectSummary(sk);

    var hd = el("div", { class: "row wrap", style: "margin-bottom:16px;gap:18px" });
    hd.appendChild(el("div", {}, [
      el("div", { style: "font-size:16px;font-weight:600", text: S.char.name || ("角色 " + S.char.id) }),
      el("div", { class: "sub", style: "color:var(--fg-3);font-size:12px;margin-top:2px",
        text: "服务器：" + (S.servers.filter(function (s) { return s.key === S.char.serverKey; })[0] || { label: S.char.serverKey }).label })
    ]));
    hd.appendChild(el("span", { class: "spacer" }));
    hd.appendChild(el("button", {
      class: "btn", text: "重新同步",
      onclick: function () { syncChar(S.char.serverKey, S.char.id); }
    }));
    hd.appendChild(el("button", {
      class: "btn", text: "切换角色",
      onclick: function () { S.char = null; S.skills = {}; S.skillOverride = {}; updateChip(); renderChar(); }
    }));
    body.appendChild(hd);

    /* 数据来源提示：令牌过期不影响已落盘的数据 */
    if (S.char.fromArchive) {
      body.appendChild(el("div", { class: "tip", style: "margin-bottom:14px", html:
        "<b>当前显示的是本地保存的数据</b>（上次同步于 " +
        (S.char.syncedAt ? new Date(S.char.syncedAt).toLocaleString("zh-CN") : "未知时间") + "）。" +
        "技能等数据已落盘，<b>不随令牌过期而失效</b>；" +
        "点「重新同步」可在重新授权后拉取最新数据。"
      }));
    }

    /* 技能参数面板 */
    body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin-bottom:10px", text: "技能参数（直接影响下方核算结果）" }));
    var grid = el("div", { class: "skill-grid" });
    SKILL_LIST.forEach(function (d) {
      var v = sk[d.id] || 0;
      var overridden = S.skillOverride[d.id] != null;
      var item = el("div", { class: "skill-item" });
      item.appendChild(el("div", { class: "nm", text: d.name }));
      item.appendChild(el("div", { class: "ef", text: d.effect }));
      var row = el("div", { class: "lv-row" });
      row.appendChild(el("span", {
        class: "lv-badge" + (v >= 5 ? " max" : ""),
        text: "Lv" + v
      }));
      var inp = el("input", {
        type: "number", min: "0", max: "5", step: "1", value: String(v),
        title: overridden ? "已手动修改（刷新页面即恢复为角色实际技能）" : ""
      });
      inp.addEventListener("change", function () {
        var n = Math.max(0, Math.min(5, parseInt(inp.value, 10) || 0));
        inp.value = String(n);
        if (S.char && S.skills[d.id] === n) {
          delete S.skillOverride[d.id];
        } else {
          S.skillOverride[d.id] = n;
        }
        renderChar();
        renderSell();
      });
      row.appendChild(inp);
      item.appendChild(row);
      item.appendChild(el("div", { class: "lvbar" }, [el("i", { style: "width:" + (v / 5 * 100) + "%" })]));
      if (overridden) {
        item.appendChild(el("div", { style: "font-size:11px;color:var(--warn);margin-top:5px", text: "已手动覆盖" }));
      }
      grid.appendChild(item);
    });
    body.appendChild(grid);

    /* 生效参数汇总 */
    body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:20px 0 10px", text: "当前生效参数" }));
    var kv = el("div", { class: "kv" });
    [
      ["市场销售税", pct(eff.salesTax), "acc"],
      ["经纪费（NPC 站）", pct(eff.brokerFee), "acc"],
      ["制造时间系数", pct(eff.timeMult), ""],
      ["同时制造槽", eff.slots + " 个", ""],
      ["同时研究槽", eff.labSlots + " 个", ""],
      ["精炼产出加成", "+" + eff.refineBonus + "%", ""]
    ].forEach(function (r) {
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: r[0] }),
        el("span", { class: "v " + (r[2] || ""), text: r[1] })
      ]));
    });
    body.appendChild(kv);
  }

  function startAuth(serverKey) {
    var scope = "esi-skills.read_skills.v1";
    location.href = "/sso/start?server=" + encodeURIComponent(serverKey) + "&scope=" + encodeURIComponent(scope);
  }

  /**
   * 从已保存的档案恢复角色状态。
   *
   * ★ 关键：角色数据（技能等）在授权成功时就落盘了，
   *   与令牌是否过期无关 —— 令牌过期后数据依然可用，
   *   只是不能自动续期、不能拉取新数据。
   */
  function restoreFromProfile(p) {
    if (!p) return false;
    var cid = p.characterId || p.id;
    if (!cid) return false;
    S.char = {
      id: cid,
      name: p.characterName,
      serverKey: p.serverKey,
      skills: p.skills || {},
      // 标记数据来自本地档案（令牌可能已过期）
      fromArchive: true,
      syncedAt: p.syncedAt || null
    };
    S.skills = p.skills || {};
    S.skillOverride = {};
    updateChip();
    return true;
  }

  function syncChar(serverKey, characterId) {
    status("charBody", '<span class="spin"></span> 正在同步角色数据…', "busy");
    api("/api/sync", { method: "POST", body: { serverKey: serverKey, characterId: characterId } })
      .then(function (j) {
        S.char = {
          id: characterId,
          name: j.characterName,
          serverKey: serverKey,
          skills: j.skills || {},
          fromArchive: false,
          syncedAt: Date.now()
        };
        S.skills = j.skills || {};
        S.skillOverride = {};
        updateChip();
        renderChar();
        renderSell();
        toast("角色数据已同步", "ok");
      })
      .catch(function (e) {
        // ★ 同步失败（多半是令牌过期）→ 回退到本地档案数据，不让用户看到空页面
        var fallback = (S.profiles || []).filter(function (p) {
          return p.serverKey === serverKey && (p.characterId || p.id) === characterId;
        })[0];
        if (fallback && restoreFromProfile(fallback)) {
          renderChar();
          renderSell();
          status("charBody",
            '<div class="tip">同步失败：' + escapeHtml(e.message) +
            '<br><b>已切换到本地保存的数据</b>（技能等已落盘，不受令牌过期影响）。' +
            '重新授权后可再次同步。</div>', "err");
        } else {
          status("charBody", "同步失败：" + escapeHtml(e.message), "err");
        }
      });
  }

  /** 转义 HTML 特殊字符（把服务端返回的错误信息插入 innerHTML 前必须用） */
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /**
   * 手动授权面板。
   *
   * 流程（对标 raoganzi.com）：
   *   1. 生成授权链接 → 2. 浏览器打开并登录授权 → 3. 把地址栏整段地址粘回来
   * 工具拿到 code 后自行换取令牌并立即同步角色数据。
   */
  function openManualPanel(serverKey) {
    var body = $("#charBody");
    var scope = "esi-skills.read_skills.v1";

    var panel = el("div", { class: "card", style: "margin-top:16px" });
    var bd = el("div", { class: "card-bd" });

    bd.appendChild(el("div", { style: "font-weight:500;margin-bottom:10px", text: "手动授权（网易官方公共 Client ID）" }));

    // 服务器选择
    var srvRow = el("div", { style: "margin-bottom:12px" });
    srvRow.appendChild(el("label", { style: "display:block;font-size:12px;color:var(--fg-2);margin-bottom:4px", text: "服务器" }));
    var srvSel = el("select", { style: "width:100%" });
    S.servers.forEach(function (sv) {
      srvSel.appendChild(el("option", { value: sv.key, text: sv.label, selected: sv.key === serverKey ? "selected" : null }));
    });
    srvRow.appendChild(srvSel);
    bd.appendChild(srvRow);

    // 流程说明
    var steps = el("div", { class: "tip", style: "margin-bottom:12px", html:
      "<b>步骤 1</b>　点下方「生成授权链接」<br>" +
      "<b>步骤 2</b>　在浏览器打开链接，登录并同意授权<br>" +
      "<b>步骤 3</b>　授权后浏览器地址栏会出现带 <code>?code=…</code> 的地址，" +
      "整段复制，粘贴到下面的输入框，点「完成授权」"
    });
    bd.appendChild(steps);

    // 授权链接区
    var linkWrap = el("div", { style: "margin-bottom:12px" });
    var linkInput = el("input", { type: "text", readonly: "readonly", placeholder: "点下方按钮生成…", style: "width:100%" });
    linkWrap.appendChild(linkInput);
    var genBtn = el("button", { class: "btn sm", text: "生成授权链接", style: "margin-top:8px" });
    var openBtn = el("button", { class: "btn sm pri", text: "在浏览器打开", style: "margin-top:8px;margin-left:8px" });
    var genRow = el("div", { style: "margin-top:8px" }, [genBtn, openBtn]);
    linkWrap.appendChild(genRow);
    bd.appendChild(linkWrap);

    // 粘贴区
    bd.appendChild(el("label", { style: "display:block;font-size:12px;color:var(--fg-2);margin-bottom:4px", text: "步骤 3：把浏览器地址栏的整段地址粘贴到这里" }));
    var pasteArea = el("textarea", { rows: "3", placeholder: "https://ali-esi.evepc.163.com/ui/oauth2-redirect.html?code=…&state=…", style: "width:100%" });
    bd.appendChild(pasteArea);

    var msg = el("div", { style: "margin-top:10px;font-size:13px" });
    bd.appendChild(msg);

    var finishBtn = el("button", { class: "btn pri", text: "完成授权", style: "margin-top:10px" });
    bd.appendChild(finishBtn);

    var currentUrl = "";

    genBtn.addEventListener("click", function () {
      genBtn.disabled = true;
      msg.textContent = "正在生成…";
      msg.className = "";
      api("/api/auth/manual?server=" + encodeURIComponent(srvSel.value) +
          "&scope=" + encodeURIComponent(scope) + "&mode=code")
        .then(function (j) {
          genBtn.disabled = false;
          currentUrl = j.url;
          linkInput.value = j.url;
          msg.textContent = "已生成，复制或直接点「在浏览器打开」。";
          msg.className = "";
        })
        .catch(function (e) {
          genBtn.disabled = false;
          msg.textContent = "生成失败：" + e.message;
          msg.className = "err";
        });
    });

    openBtn.addEventListener("click", function () {
      if (!currentUrl) { msg.textContent = "请先生成授权链接"; msg.className = "err"; return; }
      window.open(currentUrl, "_blank");
    });

    finishBtn.addEventListener("click", function () {
      var pasted = pasteArea.value.trim();
      if (!pasted) { msg.textContent = "请先粘贴回调地址"; msg.className = "err"; return; }
      finishBtn.disabled = true;
      msg.textContent = "正在换取令牌并同步角色数据…";
      msg.className = "";
      api("/api/auth/manual", {
        method: "POST",
        body: { serverKey: srvSel.value, pasted: pasted }
      })
        .then(function (j) {
          finishBtn.disabled = false;
          var lines = [];
          lines.push("✓ 授权成功：" + (j.characterName || ("角色 " + j.characterId)));
          if (j.sync && j.sync.error) lines.push("⚠ " + j.sync.error);
          else if (j.sync) lines.push("✓ 已同步 " + j.sync.skillCount + " 项技能到本地档案");
          if (j.warning) lines.push(j.warning);
          msg.innerHTML = "<div class='tip'>" + escapeHtml(lines.join("\n")).replace(/\n/g, "<br>") + "</div>";
          // 重新拉档案并刷新界面
          api("/api/profiles").then(function (r) {
            S.profiles = (r && r.profiles) || [];
            if (S.profiles.length) {
              restoreFromProfile(S.profiles[0]);
              renderChar();
              renderSell();
            }
          });
        })
        .catch(function (e) {
          finishBtn.disabled = false;
          msg.textContent = "失败：" + e.message;
          msg.className = "err";
        });
    });

    panel.appendChild(bd);
    body.appendChild(panel);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function updateChip() {    var chip = $("#charChip");
    if (S.char) {
      chip.className = "chip";
      $("#charChipTxt").textContent = S.char.name || ("角色 " + S.char.id);
    } else {
      chip.className = "chip off";
      $("#charChipTxt").textContent = "未授权";
    }
  }

  /* ================================================================ *
   * 页面：市场
   * ================================================================ */
  function renderMarket() {
    var body = $("#mktResult");
    if (!body) return;
    if (!S.fav.length) {
      $("#mktFav").innerHTML = "";
      $("#favCount").textContent = "";
      return;
    }
    $("#favCount").textContent = S.fav.length + " 项";
    var t = el("table", { class: "tbl" });
    var tb = el("tbody");
    S.fav.forEach(function (nm) {
      tb.appendChild(el("tr", {}, [
        el("td", { class: "name", text: nm }),
        el("td", { class: "num" }, [el("button", {
          class: "btn sm", text: "查询",
          onclick: function () { $("#mktSearch").value = nm; doMarketSearch(); }
        })]),
        el("td", { class: "num" }, [el("button", {
          class: "btn sm danger", text: "移除",
          onclick: function () {
            S.fav = S.fav.filter(function (x) { return x !== nm; });
            renderMarket();
          }
        })])
      ]));
    });
    t.appendChild(tb);
    $("#mktFav").innerHTML = "";
    $("#mktFav").appendChild(el("div", { class: "tbl-wrap" }, [t]));
  }

  function doMarketSearch() {
    var q = $("#mktSearch").value.trim();
    if (!q) { toast("请输入物品名称", "err"); return; }
    var typeId = typeIdByName(q);
    if (!typeId) {
      status("mktStatus", "未找到物品「" + q + "」，请确认中文名是否正确", "err");
      $("#mktResult").innerHTML = "";
      return;
    }
    status("mktStatus", '<span class="spin"></span> 正在获取「' + q + "」的行情…", "busy");
    var view = $("#marketSeg .on").dataset.v;

    if (view === "history") {
      esi(S.server, "/markets/" + regionId() + "/history/?type_id=" + typeId)
        .then(function (rows) {
          if (!rows || !rows.length) {
            status("mktStatus", "该物品在当前星域无历史成交记录", "warn");
            $("#mktResult").innerHTML = "";
            return;
          }
          status("mktStatus", "「" + q + "」历史成交 " + rows.length + " 条", "ok");
          renderHistory(rows, q);
        })
        .catch(function (e) {
          status("mktStatus", "获取历史成交失败：" + e.message, "err");
          $("#mktResult").innerHTML = "";
        });
      return;
    }

    esi(S.server, "/markets/" + regionId() + "/orders/?type_id=" + typeId)
      .then(function (orders) {
        if (!orders || !orders.length) {
          status("mktStatus", "该物品在当前星域无挂单", "warn");
          $("#mktResult").innerHTML = "";
          return;
        }
        status("mktStatus", "「" + q + "」共 " + orders.length + " 条挂单", "ok");
        renderOrders(orders, q);
      })
      .catch(function (e) {
        status("mktStatus", "获取行情失败：" + e.message, "err");
        $("#mktResult").innerHTML = "";
      });
  }

  function renderOrders(orders, itemNameZh) {
    /* ESI 的字段是 is_buy_order（true=买单），不是 is_sell_order */
    var sells = orders.filter(function (o) { return o.is_buy_order === false; })
      .sort(function (a, b) { return a.price - b.price; });
    var buys = orders.filter(function (o) { return o.is_buy_order === true; })
      .sort(function (a, b) { return b.price - a.price; });

    var wrap = el("div", { class: "grid g2" });

    function side(title, list, isSell) {
      var card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-hd" }, [
        el("h2", { text: title }),
        el("span", { class: "sub", text: list.length + " 条" })
      ]));
      var tb = el("tbody");
      list.slice(0, 40).forEach(function (o) {
        tb.appendChild(el("tr", {}, [
          el("td", { class: "num " + (isSell ? "" : "down"), text: isk(o.price) }),
          el("td", { class: "num", text: num(o.volume_remain) }),
          el("td", { class: "num muted", text: num(o.volume_total) }),
          el("td", { class: "muted", style: "font-size:11px", text: o.location_id ? ("地点 " + o.location_id) : "" })
        ]));
      });
      var t = el("table", { class: "tbl" });
      t.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", { class: "num", text: "单价" }),
        el("th", { class: "num", text: "剩余" }),
        el("th", { class: "num", text: "总量" }),
        el("th", { text: "" })
      ])]));
      t.appendChild(tb);
      card.appendChild(el("div", { class: "card-bd tight" }, [el("div", { class: "tbl-wrap", style: "max-height:340px;overflow-y:auto" }, [t])]));
      return card;
    }

    wrap.appendChild(side("卖单（升序）", sells, true));
    wrap.appendChild(side("买单（降序）", buys, false));

    var box = el("div");
    box.appendChild(el("div", { class: "row", style: "margin-bottom:10px" }, [
      el("span", { style: "font-size:13px;color:var(--fg-2)", text: "「" + itemNameZh + "」实时挂单" }),
      el("span", { class: "spacer" }),
      el("span", { class: "tag", text: "市场 " + regionName() })
    ]));
    box.appendChild(wrap);
    $("#mktResult").innerHTML = "";
    $("#mktResult").appendChild(box);
  }

  function renderHistory(rows, itemNameZh) {
    var tb = el("tbody");
    rows.slice().reverse().slice(0, 60).forEach(function (r) {
      tb.appendChild(el("tr", {}, [
        el("td", { class: "muted", style: "font-size:11px", text: r.date ? r.date.slice(0, 10) : "" }),
        el("td", { class: "num", text: isk(r.average) }),
        el("td", { class: "num", text: isk(r.lowest) }),
        el("td", { class: "num", text: isk(r.highest) }),
        el("td", { class: "num muted", text: num(r.volume) }),
        el("td", { class: "num muted", text: num(r.order_count) })
      ]));
    });
    var t = el("table", { class: "tbl" });
    t.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "日期" }),
      el("th", { class: "num", text: "均价" }),
      el("th", { class: "num", text: "最低" }),
      el("th", { class: "num", text: "最高" }),
      el("th", { class: "num", text: "成交量" }),
      el("th", { class: "num", text: "订单数" })
    ])]));
    t.appendChild(tb);
    $("#mktResult").innerHTML = "";
    $("#mktResult").appendChild(el("div", { class: "card" }, [
      el("div", { class: "card-hd" }, [
        el("h2", { text: "「" + itemNameZh + "」历史成交" }),
        el("span", { class: "sub", text: rows.length + " 条记录（显示最近 60 条）" })
      ]),
      el("div", { class: "card-bd tight" }, [el("div", { class: "tbl-wrap" }, [t])])
    ]));
  }

  /* ================================================================ *
   * 页面：工业
   * ================================================================ */
  function renderIndustry() {
    var body = $("#indBody");
    body.innerHTML = "";
    Promise.all([table("facility_rates"), table("cost_index"), table("universe")])
      .then(function (r) {
        var rates = r[0], idx = r[1], uni = r[2];
        var sysId = currentSystemId();
        var sys = uni.systems.filter(function (s) { return s.id === sysId; })[0];
        var sysName = sys ? (sys.zh || sys.name) : "未知星系";
        $("#indSystemInfo").textContent = "当前星系：" + sysName;

        var ci = idx.filter(function (x) { return x.systemId === sysId; })[0];
        var indices = ci ? ci.indices : {};

        body.appendChild(el("div", { class: "tip", html:
          "<b>工业费口径说明。</b>制造费不是按材料实际成本算，而是按" +
          "<b>产物的估算市场价值 × 星系成本指数</b> 计入，再叠加设施基础费与设施税。" +
          "<br>下方是当前星系的成本指数与设施费率 —— 换星系会显著改变制造费。"
        }));

        var kv = el("div", { class: "kv", style: "margin-top:16px" });
        var idxName = {
          manufacturing: "制造", researching_time_efficiency: "时间效率研究",
          researching_material_efficiency: "材料效率研究", copying: "拷贝",
          invention: "发明", reaction: "反应"
        };
        Object.keys(idxName).forEach(function (k) {
          if (indices[k] == null) return;
          kv.appendChild(el("div", { class: "r" }, [
            el("span", { class: "k", text: idxName[k] + " 成本指数" }),
            el("span", { class: "v", text: (indices[k] * 100).toFixed(2) + "%" })
          ]));
        });
        body.appendChild(kv);

        body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:20px 0 10px",
          text: "设施分布（当前星域各设施类型的实例数量）" }));
        var tb = el("tbody");
        rates.slice(0, 20).forEach(function (f) {
          /* 设施的中文名官方包未收录（35 个设施全部无中文名），用英文名 */
          var nm = itemName(f.typeId);
          tb.appendChild(el("tr", {}, [
            el("td", { class: "name", text: nm }),
            el("td", { class: "num", text: num(f.count) }),
            el("td", { class: "num muted", text: f.avgOwner ? num(f.avgOwner, 0) : "—" })
          ]));
        });
        var t = el("table", { class: "tbl" });
        t.appendChild(el("thead", {}, [el("tr", {}, [
          el("th", { text: "设施类型" }),
          el("th", { class: "num", text: "实例数量" }),
          el("th", { class: "num", text: "平均业主 ID" })
        ])]));
        t.appendChild(tb);
        body.appendChild(el("div", { class: "card" }, [
          el("div", { class: "card-bd tight" }, [el("div", { class: "tbl-wrap", style: "max-height:400px;overflow-y:auto" }, [t])])
        ]));
        body.appendChild(el("div", { class: "tip warn", style: "margin-top:14px", html:
          "<b>关于设施费率。</b>ESI 的 <code>/industry/facilities/</code> 只返回「设施实例 + 所属公司 ID」，" +
          "<b>不包含费率本身</b>——费率由各公司自行设定，需逐个查询公司资料才能取得。" +
          "<br>因此本工具的制造费采用另一条官方口径：<b>产物估算价值 × 星系成本指数</b> + 你手动填写的设施基础费。" +
          "<br>另：EVE 官方包未收录设施的中文名，故此处显示英文名。"
        }));
      })
      .catch(function (e) {
        body.appendChild(el("div", { class: "status err", text: "加载工业数据失败：" + e.message }));
      });
  }

  /* ================================================================ *
   * 页面：蓝图画廊与制造核算
   * ================================================================ */
  function doBpSearch() {
    var q = $("#bpSearch").value.trim();
    if (!q) { toast("请输入产物名称或类别（如 护卫舰）", "err"); return; }
    status("bpStatus", '<span class="spin"></span> 正在搜索蓝图…', "busy");
    Promise.all([table("blueprints"), table("item_names"), table("item_categories")])
      .then(function (r) {
        var bp = r[0], cats = r[2];
        var hits = [];

        /* 蓝图的 key 是「蓝图 typeID」，产物 typeID 在 product 字段 ——
           建 product → blueprint 的反向索引，供按物品名/类别匹配 */
        var byProduct = {};
        Object.keys(bp).forEach(function (btid) {
          var p = bp[btid].product;
          if (p != null) byProduct[String(p)] = btid;
        });

        /* ① 直接按物品名匹配 */
        Object.keys(byProduct).forEach(function (pid) {
          var nm = itemName(pid);
          if (nm === q) {
            var btid = byProduct[pid];
            hits.push({ tid: Number(btid), bp: bp[btid], name: nm, kind: "名称精确匹配" });
          }
        });

        /* ② 按类别关键词匹配（如「护卫舰」→ 矮脚鸡级、秃鹫级…） */
        var kwIds = (cats.keywordItems && cats.keywordItems[q]) || null;
        if (kwIds) {
          kwIds.forEach(function (tid) {
            var btid = byProduct[String(tid)];
            if (!btid) return;
            var nm = itemName(tid);
            if (!nm) return;
            hits.push({
              tid: Number(btid),
              bp: bp[btid],
              name: nm,
              kind: "类别：" + q
            });
          });
        }

        /* ③ 名称包含（模糊） */
        if (!hits.length) {
          Object.keys(byProduct).forEach(function (pid) {
            var nm = itemName(pid);
            if (nm && nm.indexOf(q) >= 0) {
              var btid = byProduct[pid];
              hits.push({ tid: Number(btid), bp: bp[btid], name: nm, kind: "名称包含" });
            }
          });
        }

        /* ④ 材料名匹配 */
        if (!hits.length) {
          Object.keys(bp).forEach(function (btid) {
            var b = bp[btid];
            var mats = (b.materials || []).map(function (m) { return itemName(m[0]); });
            if (mats.indexOf(q) >= 0) {
              hits.push({ tid: Number(btid), bp: b, name: itemName(b.product), kind: "含材料 " + q });
            }
          });
        }

        if (!hits.length) {
          status("bpStatus", "未找到与「" + q + "」相关的蓝图。<br>" +
            "提示：舰船的正式中文名是船名（如「矮脚鸡级」），" +
            "也可直接搜类别词（护卫舰、驱逐舰、巡洋舰、战列舰、炮塔…）。", "warn");
          $("#bpList").innerHTML = "";
          return;
        }
        // 去重
        var seen = {}, uniq = [];
        hits.forEach(function (h) {
          if (seen[h.tid]) return;
          seen[h.tid] = 1;
          uniq.push(h);
        });
        status("bpStatus", "找到 " + uniq.length + " 个蓝图" +
          (kwIds ? "（类别「" + q + "」）" : ""), "ok");
        renderBpList(uniq.slice(0, 80));
      }).catch(function (e) {
        status("bpStatus", "搜索失败：" + e.message, "err");
      });
  }

  function renderBpList(hits) {
    var tb = el("tbody");
    hits.forEach(function (h) {
      var mats = (h.bp.materials || []).length;
      tb.appendChild(el("tr", {}, [
        el("td", { class: "name", text: h.name }),
        el("td", {}, [el("span", { class: "tag", text: h.kind || "蓝图" })]),
        el("td", { class: "num", text: num(h.bp.productQty) }),
        el("td", { class: "num muted", text: mats + " 种" }),
        el("td", { class: "num" }, [el("button", {
          class: "btn sm pri", text: "核算",
          onclick: function () { openBpCalc(h.tid); }
        })])
      ]));
    });
    var t = el("table", { class: "tbl" });
    t.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "产物" }), el("th", { text: "匹配方式" }),
      el("th", { class: "num", text: "单流程产出" }),
      el("th", { class: "num", text: "材料" }), el("th", { class: "num", text: "" })
    ])]));
    t.appendChild(tb);
    $("#bpList").innerHTML = "";
    $("#bpList").appendChild(el("div", { class: "tbl-wrap" }, [t]));
    $("#bpListCount").textContent = hits.length + " 个蓝图（列表可滚动）";
  }

  function openBpCalc(tid) {
    status("bpStatus", "正在加载蓝图…", "busy");
    Promise.all([table("blueprints"), table("industry"), table("item_names")]).then(function (r) {
      var bp = r[0], ind = r[1];
      var b = bp[String(tid)];
      if (!b) { status("bpStatus", "蓝图不存在", "err"); return; }
      S.pendingBp = { tid: tid, bp: b, times: (ind.times && ind.times[String(tid)]) || {}, mats: ind.mats || {}, prods: ind.prods || {} };
      $("#bpCalcCard").style.display = "";
      renderBpCalc();
      status("bpStatus", "已载入蓝图，点击「拉取材料价」自动填价", "ok");
      // 核算面板在搜索框下方，滚动到可见位置
      $("#bpCalcCard").scrollIntoView({ behavior: "smooth", block: "start" });
    }).catch(function (e) {
      status("bpStatus", "加载失败：" + e.message, "err");
    });
  }

  function renderBpCalc() {
    var P = S.pendingBp;
    if (!P) return;
    var b = P.bp;
    var body = $("#bpCalcBody");
    body.innerHTML = "";

    $("#bpCalcTitle").textContent = itemName(b.product);
    var t = P.times["1"];
    $("#bpCalcMeta").textContent = "基础耗时 " + (t ? formatDuration(t) : "未知") +
      " · 单流程产出 " + num(b.productQty);

    /* 参数区 */
    var params = el("div", { class: "grid g4", style: "margin-bottom:18px" });
    function numField(label, value, key, step) {
      var inp = el("input", { type: "number", class: "mono", value: String(value), step: step || "1", min: "0" });
      inp.addEventListener("change", function () {
        P[key] = parseFloat(inp.value) || 0;
        renderBpCalc();
      });
      return el("label", { class: "fld" }, [el("span", { text: label }), inp]);
    }
    P.me = P.me == null ? 0 : P.me;
    P.te = P.te == null ? 0 : P.te;
    P.runs = P.runs == null ? 1 : P.runs;
    P.jobFee = P.jobFee == null ? 0 : P.jobFee;
    P.sellPrice = P.sellPrice || 0;

    params.appendChild(numField("材料效率 ME（级）", P.me, "me"));
    params.appendChild(numField("时间效率 TE（级）", P.te, "te"));
    params.appendChild(numField("流程数 runs", P.runs, "runs"));
    params.appendChild(numField("工业费（ISK/流程）", P.jobFee, "jobFee"));
    body.appendChild(params);

    var sellInp = el("input", { type: "number", class: "mono", value: String(P.sellPrice), step: "0.01", min: "0" });
    sellInp.addEventListener("change", function () {
      P.sellPrice = parseFloat(sellInp.value) || 0;
      renderBpCalc();
    });
    body.appendChild(el("label", { class: "fld" }, [
      el("span", { text: "产物卖价（ISK/单位）" }), sellInp
    ]));

    /* 材料表 */
    var mats = (b.materials || []).map(function (m) { return { typeId: m[0], base: m[1] }; });
    var tb = el("tbody");
    mats.forEach(function (m) {
      var qty = window.EveCalc.materialQuantity(m.base, P.me, P.runs);
      P.matsQty = P.matsQty || {};
      P.matsQty[m.typeId] = qty;
      var price = (P.matsPrice || {})[m.typeId];
      var cost = price != null ? price * qty : null;

      var priceInp = el("input", {
        type: "number", class: "cell-in w-sm", placeholder: "单价",
        value: price != null ? String(price) : ""
      });
      priceInp.addEventListener("change", function () {
        P.matsPrice = P.matsPrice || {};
        var v = parseFloat(priceInp.value);
        if (isFinite(v)) P.matsPrice[m.typeId] = v; else delete P.matsPrice[m.typeId];
        renderBpCalc();
      });

      tb.appendChild(el("tr", {}, [
        el("td", { class: "name", text: itemName(m.typeId) }),
        el("td", { class: "num muted", text: num(m.base) }),
        el("td", { class: "num", text: num(qty) }),
        el("td", { class: "num" }, [priceInp]),
        el("td", { class: "num", text: cost == null ? "—" : isk(cost) })
      ]));
    });
    var t = el("table", { class: "tbl" });
    t.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "材料" }), el("th", { class: "num", text: "基础数量" }),
      el("th", { class: "num", text: "实际数量" }), el("th", { class: "num", text: "单价" }),
      el("th", { class: "num", text: "小计" })
    ])]));
    t.appendChild(tb);

    /* 拉价按钮 */
    var bar = el("div", { class: "row", style: "margin:14px 0" }, [
      el("button", {
        class: "btn pri", text: "拉取材料价",
        title: "优先用本地 EIV 基准价（快）；缺失时回退到市场卖单最低价",
        onclick: function () { pullMatPrices(mats.map(function (m) { return m.typeId; })); }
      }),
      el("button", {
        class: "btn", text: "清空价格",
        onclick: function () { P.matsPrice = {}; renderBpCalc(); }
      }),
      el("span", { class: "spacer" }),
      el("span", { class: "sub", style: "font-size:12px;color:var(--fg-3)", text: "在「" + regionName() + "」查询卖单最低价" })
    ]);

    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "card-bd tight" }, [
        el("div", { class: "tbl-wrap" }, [t])
      ])
    ]));
    body.insertBefore(bar, body.children[1]);

    /* 结果 */
    var priced = mats.filter(function (m) { return (P.matsPrice || {})[m.typeId] != null; });
    if (priced.length) {
      var matsCost = priced.reduce(function (s, m) {
        return s + P.matsPrice[m.typeId] * P.matsQty[m.typeId];
      }, 0);
      var cost = window.EveCalc.manufacturingCost({
        materialsCost: matsCost,
        jobFee: P.jobFee,
        productQty: b.productQty,
        runs: P.runs
      });
      var sk = effectiveSkills();
      var tax = window.EveCalc.salesTaxRate(sk);
      var fee = window.EveCalc.brokerFeeRate(sk);
      var timeMult = window.EveCalc.timeMult
        ? window.EveCalc.timeMult(sk)
        : window.EveCalc.manufacturingTimeMult(sk);
      var baseTime = t || 0;
      var realTime = baseTime * (P.te != null ? window.EveCalc.timeFactor(P.te) : 1) * timeMult;

      var rev = P.sellPrice > 0 ? window.EveCalc.sellRevenue({
        sellPrice: P.sellPrice,
        costPerItem: cost.perItem,
        qty: b.productQty * P.runs,
        salesTax: tax,
        brokerFee: fee
      }) : null;

      var kv = el("div", { class: "kv" });
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "材料成本（" + priced.length + "/" + mats.length + " 项已定价）" }),
        el("span", { class: "v", text: isk(matsCost) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "单流程成本" }),
        el("span", { class: "v", text: isk(cost.perRun) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "单件成本" }),
        el("span", { class: "v big", text: isk(cost.perItem) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "总成本（" + P.runs + " 流程）" }),
        el("span", { class: "v", text: isk(cost.total) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "实际耗时（TE + 工业理论 + 高级工业理论）" }),
        el("span", { class: "v", text: formatDuration(realTime) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "销售税 / 经纪费" }),
        el("span", { class: "v", text: pct(tax) + " / " + pct(fee) })
      ]));
      if (rev) {
        kv.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "毛收入" }),
          el("span", { class: "v", text: isk(rev.gross) })
        ]));
        kv.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "净利润" }),
          el("span", { class: "v big " + (rev.profit >= 0 ? "pos" : "neg"), text: isk(rev.profit) })
        ]));
        kv.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "投资回报率 / 毛利率" }),
          el("span", { class: "v " + (rev.margin >= 0 ? "pos" : "neg"),
            text: rev.margin.toFixed(2) + "% / " + rev.netMargin.toFixed(2) + "%" })
        ]));
        kv.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "保本价" }),
          el("span", { class: "v", text: isk(rev.breakEvenPrice) })
        ]));
      }
      body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:20px 0 10px", text: "核算结果" }));
      body.appendChild(kv);
    }
  }

  /**
   * 拉取材料价格。
   *
   * 策略：
   *   ① 优先用本地 EIV 基准价（/api/eiv，一次返回全量，快且稳）
   *   ② EIV 缺失时回退到逐个查订单（真实挂单价，更准但慢）
   */
  function pullMatPrices(typeIds) {
    if (!typeIds.length) return;
    status("bpStatus", '<span class="spin"></span> 正在获取材料价格…', "busy");

    // ① EIV 基准价
    api("/api/eiv?server=" + encodeURIComponent(S.server))
      .then(function (j) {
        var prices = j.prices || {};
        var got = {}, miss = 0;
        typeIds.forEach(function (tid) {
          var v = prices[String(tid)];
          /* EIV 条目形如 { adjusted, average } —— 用 average（成交均价）更贴近实际 */
          var price = v == null ? null
            : (typeof v === "object" ? (v.average != null ? v.average : v.adjusted) : v);
          if (price != null && price > 0) got[tid] = price; else miss++;
        });
        if (!Object.keys(got).length) {
          // EIV 里没有这些物品 → 回退查订单
          return pullMatPricesByOrders(typeIds);
        }
        S.pendingBp.matsPrice = got;
        var msg = "已填入 " + Object.keys(got).length + "/" + typeIds.length +
          " 项材料价（EIV 基准价）";
        if (miss) msg += "，" + miss + " 项无基准价";
        status("bpStatus", msg, miss ? "warn" : "ok");
        renderBpCalc();
      })
      .catch(function () {
        pullMatPricesByOrders(typeIds);
      });
  }

  /** 回退：逐个查 ESI 订单，取卖单最低价 */
  function pullMatPricesByOrders(typeIds) {
    var got = {}, done = 0, failed = 0;
    var CONC = 6;

    function one(tid) {
      return esi(S.server, "/markets/" + regionId() + "/orders/?type_id=" + tid + "&order_type=sell")
        .then(function (orders) {
          if (orders && orders.length) {
            var min = Infinity;
            orders.forEach(function (o) { if (o.price < min) min = o.price; });
            if (isFinite(min) && min > 0) got[tid] = min;
          }
        })
        .catch(function () { failed++; })
        .then(function () {
          done++;
          status("bpStatus", '<span class="spin"></span> 已查询 ' + done + "/" + typeIds.length + " 项材料价…", "busy");
        });
    }

    // 分批并发
    var idx = 0;
    function worker() {
      if (idx >= typeIds.length) return Promise.resolve();
      var t = typeIds[idx++];
      return one(t).then(worker);
    }
    var workers = [];
    for (var i = 0; i < Math.min(CONC, typeIds.length); i++) workers.push(worker());
    Promise.all(workers).then(function () {
      S.pendingBp.matsPrice = got;
      var n = Object.keys(got).length;
      status("bpStatus", n
        ? "已填入 " + n + "/" + typeIds.length + " 项材料价（市场卖单最低价）"
        : "未能获取材料价格 —— 请检查网络或换用系统浏览器（内置浏览器可能有网易 Cookie 干扰）",
        n ? "ok" : "err");
      renderBpCalc();
    });
  }

  function formatDuration(sec) {
    if (!sec || !isFinite(sec)) return "—";
    var s = Math.round(sec);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h > 0) return h + " 小时 " + m + " 分";
    if (m > 0) return m + " 分 " + ss + " 秒";
    return ss + " 秒";
  }

  /* ================================================================ *
   * 页面：挂单收益
   * ================================================================ */
  function renderSell() {
    var body = $("#sellBody");
    body.innerHTML = "";

    var sk = effectiveSkills();
    var tax = window.EveCalc.salesTaxRate(sk);
    var fee = window.EveCalc.brokerFeeRate(sk);
    var slots = window.EveCalc.manufacturingSlots(sk);

    body.appendChild(el("div", { class: "tip", html:
      "当前税率取自你的角色技能：销售税 <b>" + pct(tax) + "</b>、经纪费 <b>" + pct(fee) +
      "</b>、同时制造槽 <b>" + slots + "</b> 个。" +
      (S.char ? "" : "<br>★ 尚未授权角色，税率按 0 级技能计算 —— 可在「角色」页授权后自动代入。")
    }));

    var p = S.sellCalc = S.sellCalc || { cost: 10000, qty: 100, price: 0, targetPct: 15, seconds: 600, productQty: 1 };

    var grid = el("div", { class: "grid g4", style: "margin-top:16px" });
    function f(label, key, step) {
      var inp = el("input", { type: "number", class: "mono", value: String(p[key] || 0), step: step || "1", min: "0" });
      inp.addEventListener("input", function () { p[key] = parseFloat(inp.value) || 0; calcSell(); });
      return el("label", { class: "fld" }, [el("span", { text: label }), inp]);
    }
    grid.appendChild(f("单件成本（ISK）", "cost", "0.01"));
    grid.appendChild(f("数量", "qty"));
    /* 目标回报率：输入为百分数（如 15 表示 15%），内部转小数 */
    grid.appendChild(f("目标回报率（%）", "targetPct", "0.1"));
    grid.appendChild(f("单流程耗时（秒）", "seconds"));
    body.appendChild(grid);

    var priceInp = el("input", { type: "number", class: "mono", value: String(p.price || 0), step: "0.01", min: "0" });
    priceInp.addEventListener("input", function () { p.price = parseFloat(priceInp.value) || 0; calcSell(); });
    body.appendChild(el("label", { class: "fld" }, [el("span", { text: "卖价（ISK/单位）" }), priceInp]));

    var out = el("div", { id: "sellOut" });
    body.appendChild(out);
    calcSell();

    function calcSell() {
      out.innerHTML = "";
      var tax2 = window.EveCalc.salesTaxRate(sk);
      var fee2 = window.EveCalc.brokerFeeRate(sk);
      /* 输入为百分数（15 = 15%），公式需要小数（0.15） */
      var target = (p.targetPct || 0) / 100;

      var kv = el("div", { class: "kv" });
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "达到目标回报率 " + (p.targetPct || 0) + "% 的最低卖价" }),
        el("span", { class: "v big acc", text: isk(window.EveCalc.priceForMargin({
          costPerItem: p.cost, salesTax: tax2, brokerFee: fee2, targetMargin: target
        })) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "达到目标毛利率 " + (p.targetPct || 0) + "% 的最低卖价" }),
        el("span", { class: "v", text: isk(window.EveCalc.priceForNetMargin({
          costPerItem: p.cost, salesTax: tax2, brokerFee: fee2, targetMargin: target
        })) })
      ]));
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: "保本价（不含任何利润）" }),
        el("span", { class: "v", text: isk(p.cost / Math.max(1e-9, 1 - tax2 - fee2)) })
      ]));
      out.appendChild(kv);

      if (p.price > 0) {
        var rev = window.EveCalc.sellRevenue({
          sellPrice: p.price, costPerItem: p.cost, qty: p.qty,
          salesTax: tax2, brokerFee: fee2
        });
        var kv2 = el("div", { class: "kv", style: "margin-top:18px" });
        [
          ["毛收入", isk(rev.gross), ""],
          ["销售税", "−" + isk(rev.taxAmount), ""],
          ["经纪费", "−" + isk(rev.feeAmount), ""],
          ["净收入", isk(rev.net), ""],
          ["总成本", isk(rev.cost), ""],
          ["净利润", isk(rev.profit), rev.profit >= 0 ? "pos" : "neg"],
          ["投资回报率（利润/成本）", rev.margin.toFixed(2) + "%", rev.margin >= 0 ? "pos" : "neg"],
          ["毛利率（利润/毛收入）", rev.netMargin.toFixed(2) + "%", rev.netMargin >= 0 ? "pos" : "neg"]
        ].forEach(function (r) {
          kv2.appendChild(el("div", { class: "r" }, [
            el("span", { class: "k", text: r[0] }),
            el("span", { class: "v " + r[2], text: r[1] })
          ]));
        });
        out.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:18px 0 10px", text: "按当前卖价计算" }));
        out.appendChild(kv2);
      }

      /* 日产能 */
      if (p.seconds > 0) {
        var d = window.EveCalc.dailyOutput({ secondsPerRun: p.seconds, slots: slots, productQty: p.productQty || 1 });
        var kv3 = el("div", { class: "kv", style: "margin-top:18px" });
        kv3.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "每日流程数（" + slots + " 槽）" }),
          el("span", { class: "v", text: num(d.runsPerDay, 1) })
        ]));
        kv3.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "每日产出件数" }),
          el("span", { class: "v", text: num(d.itemsPerDay, 1) })
        ]));
        kv3.appendChild(el("div", { class: "r" }, [
          el("span", { class: "k", text: "每日理论毛收入" }),
          el("span", { class: "v", text: p.price > 0 ? isk(p.price * d.itemsPerDay) : "—" })
        ]));
        out.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:18px 0 10px", text: "日产能估算" }));
        out.appendChild(kv3);
      }
    }
  }

  /* ================================================================ *
   * 页面：提炼
   * ================================================================ */
  function renderRefine() {
    var body = $("#refineBody");
    body.innerHTML = "";
    Promise.all([table("ore_refine"), table("item_names")]).then(function (r) {
      var ores = r[0];
      var names = Object.keys(ores);

      body.appendChild(el("div", { class: "tip", html:
        "<b>提炼产出</b>受「提炼学概论」（每级 +3%）与「提炼效率理论」（每级 +2%）影响。" +
        "你的技能合计加成：<b>+" + window.EveCalc.refineYieldBonusPct(effectiveSkills()) + "%</b>。"
      }));

      var sel = el("select", { style: "max-width:260px;margin:16px 0" });
      names.forEach(function (n) { sel.appendChild(el("option", { value: n, text: n })); });
      var out = el("div");
      sel.addEventListener("change", function () { drawOres(sel.value, out); });
      body.appendChild(sel);
      body.appendChild(out);
      drawOres(names[0], out);
    }).catch(function (e) {
      body.appendChild(el("div", { class: "status err", text: "加载矿石数据失败：" + e.message }));
    });

    function drawOres(name, out) {
      out.innerHTML = "";
      var o = S.loaded.ore_refine[name];
      if (!o) return;
      var bonus = window.EveCalc.refineYieldBonusPct(effectiveSkills()) / 100;
      var tb = el("tbody");
      o.levels.forEach(function (lv) {
        var prodRow = [];
        lv.prods.forEach(function (p) {
          var qty = p.qty * (1 + bonus);
          prodRow.push(p.name + " × " + num(qty, 1));
        });
        tb.appendChild(el("tr", {}, [
          el("td", { class: "name", text: lv.name }),
          el("td", { class: "num", text: "Lv" + lv.level }),
          el("td", { class: "muted", style: "font-size:12px", text: prodRow.join("、") })
        ]));
      });
      var t = el("table", { class: "tbl" });
      t.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", { text: "矿石" }), el("th", { class: "num", text: "级别" }),
        el("th", { text: "精炼产出（含技能加成）" })
      ])]));
      t.appendChild(tb);
      out.appendChild(el("div", { class: "card" }, [
        el("div", { class: "card-bd tight" }, [el("div", { class: "tbl-wrap" }, [t])])
      ]));
    }
  }

  /* ================================================================ *
   * 页面：设置
   * ================================================================ */
  function renderSet() {
    var body = $("#setBody");
    body.innerHTML = "";

    body.appendChild(el("div", { class: "tip", html:
      "<b>本地单用户模式。</b>数据保存在本机 <code>用户数据/users/local/</code>，" +
      "令牌以 AES-256-GCM 加密落盘。局域网与公网默认不可访问（只监听 127.0.0.1）。"
    }));

    var kv = el("div", { class: "kv", style: "margin-top:16px" });
    [
      ["运行模式", S.char ? "已授权角色" : "未授权（单用户）", ""],
      ["服务器", serverLabel(), "acc"],
      ["市场星域", regionName(), ""],
      ["销售税率", pct(window.EveCalc.salesTaxRate(effectiveSkills())), "acc"],
      ["经纪费率", pct(window.EveCalc.brokerFeeRate(effectiveSkills())), "acc"],
      ["制造槽 / 实验室槽", window.EveCalc.manufacturingSlots(effectiveSkills()) + " / " + window.EveCalc.labSlots(effectiveSkills()), ""]
    ].forEach(function (r) {
      kv.appendChild(el("div", { class: "r" }, [
        el("span", { class: "k", text: r[0] }),
        el("span", { class: "v " + r[2], text: r[1] })
      ]));
    });
    body.appendChild(kv);

    /* ---------- 授权凭据（分服独立配置）---------- */
    body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:24px 0 10px", text: "授权凭据（各服独立）" }));
    body.appendChild(el("div", { class: "tip", html:
      "三套集群的应用<b>互不通用</b>：欧服在 <code>developers.eveonline.com</code> 注册，" +
      "国服在网易开发者后台注册；<b>曙光服是独立集群，需单独注册</b>，不能与晨曦共用 Client ID。" +
      "<br>回调地址必须与后台登记的<b>逐字符一致</b>（协议、主机、端口、路径、末尾斜杠都算），" +
      "否则网易会返回 <code>redirect URL does not match</code>。" +
      "<br>⚠ 网易的官方公共 Client ID <code>bc90aa49…</code> 只登记了官方落地页，" +
      "用它做本地授权必然失败，建议换成自己注册的。"
    }));

    var cfgBox = el("div", { class: "card", style: "margin-top:12px" });
    var cfgBd = el("div", { class: "card-bd" });
    var srvList = (S.cfg && S.cfg.servers) ? S.cfg.servers : [];

    srvList.forEach(function (srv) {
      var box = el("div", { style: "border-bottom:1px solid var(--line);padding:14px 0" });

      var head = el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap" }, [
        el("b", { text: srv.label }),
        el("span", {
          class: "tag " + (srv.clientIdConfigured ? "neg" : ""),
          text: srv.clientIdConfigured ? "已配置 Client ID" : "未配置"
        }),
        srv.usingOfficialClientId ? el("span", { class: "tag neg", text: "网易官方公共 ID（回调地址受限）" }) : null,
        el("span", { class: "muted", style: "font-size:12px", text: "当前回调：" + (srv.redirectUri || "—") })
      ]);
      box.appendChild(head);

      var inputs = {};

      function addField(label, key, placeholder, isPassword) {
        var wrap = el("div", { style: "margin:8px 0" });
        wrap.appendChild(el("label", { style: "display:block;font-size:12px;color:var(--fg-2);margin-bottom:4px", text: label }));
        var i = el("input", {
          type: isPassword ? "password" : "text",
          placeholder: placeholder || "",
          style: "width:100%"
        });
        // 回显已保存的值（Client ID 与回调地址可回显；secret 不回传）
        if (key === "clientId" && srv.clientId) i.value = srv.clientId;
        else if (key === "redirectUri" && srv.redirectUri) i.value = srv.redirectUri;
        else if (key === "clientSecret") i.placeholder = srv.clientSecretSet ? "已设置（留空则不修改）" : "留空即可（PKCE 不需要）";
        i.value = (S.credentials && S.credentials[srv.key] && S.credentials[srv.key][key]) || i.value;
        inputs[key] = i;
        wrap.appendChild(i);
        return wrap;
      }

      box.appendChild(addField("Client ID", "clientId",
        srv.key === "tranquility" ? "在 developers.eveonline.com 注册后填入" : "在网易开发者后台为该服注册后填入"));
      box.appendChild(addField("Client Secret（选填，PKCE 不需要）", "clientSecret", "留空即可", true));
      box.appendChild(addField("回调地址（须与后台登记完全一致）", "redirectUri", srv.redirectUri || ""));

      var btn = el("button", { class: "btn sm pri", text: "保存该服配置" });
      btn.addEventListener("click", function () {
        var payload = {};
        payload[srv.key] = {
          clientId: inputs.clientId.value.trim(),
          clientSecret: inputs.clientSecret.value.trim(),
          redirectUri: inputs.redirectUri.value.trim()
        };
        btn.disabled = true;
        api("/api/config", { method: "POST", body: JSON.stringify({ servers: payload }) })
          .then(function () {
            btn.disabled = false;
            btn.textContent = "已保存 ✓";
            setTimeout(function () { btn.textContent = "保存该服配置"; }, 1600);
            loadConfig();
          })
          .catch(function (e) {
            btn.disabled = false;
            btn.textContent = "保存失败：" + (e && e.message ? e.message : "未知错误");
          });
      });
      box.appendChild(el("div", { style: "margin-top:10px" }, [btn]));
      cfgBd.appendChild(box);
    });

    cfgBox.appendChild(cfgBd);
    body.appendChild(cfgBox);

    /* 数据表状态 */
    body.appendChild(el("div", { style: "font-size:13px;color:var(--fg-2);margin:20px 0 10px", text: "内置数据库" }));
    var tb = el("tbody");
    var tables = [
      ["item_names.json", "物品中文名"], ["item_names_en.json", "物品英文名"],
      ["blueprints.json", "蓝图"], ["industry.json", "工业活动耗时/材料/产物"],
      ["universe.json", "宇宙三级数据"], ["ore_refine.json", "矿石分级"],
      ["cost_index.json", "星系成本指数"], ["facility_rates.json", "设施费率"],
      ["market_groups.json", "市场分组"], ["pi_schematics.json", "行星工业配方"],
      ["stations.json", "NPC 空间站"], ["structures.json", "玩家公开建筑"],
      ["item_categories.json", "物品类别映射"],
      ["skills.json", "技能效果表"], ["tax_config.json", "税率配置"]
    ];
    tables.forEach(function (t) {
      tb.appendChild(el("tr", {}, [
        el("td", { class: "name mono", style: "font-size:12px", text: t[0] }),
        el("td", { class: "muted", text: t[1] }),
        el("td", { class: "num" }, [el("span", {
          class: "tag " + (S.loaded[t[0].replace(".json", "")] ? "neg" : ""),
          text: S.loaded[t[0].replace(".json", "")] ? "已加载" : "未加载"
        })])
      ]));
    });
    var tt = el("table", { class: "tbl" });
    tt.appendChild(el("thead", {}, [el("tr", {}, [
      el("th", { text: "数据表" }), el("th", { text: "内容" }), el("th", { class: "num", text: "状态" })
    ])]));
    tt.appendChild(tb);
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "card-bd tight" }, [el("div", { class: "tbl-wrap" }, [tt])])
    ]));
  }

  /* ================================================================ *
   * 服务器与区域
   * ================================================================ */

  /**
   * 载入 /api/config：各服状态、当前生效的回调地址与已保存的 Client ID。
   * 保存凭据后需重新调用，以刷新设置页的显示。
   */
  function loadConfig() {
    return api("/api/config").then(function (cfg) {
      S.cfg = cfg;
      S.servers = cfg.servers || [];
      // 回显各服已保存的凭据
      S.credentials = {};
      S.servers.forEach(function (sv) {
        S.credentials[sv.key] = {
          clientId: sv.clientId || "",
          redirectUri: sv.redirectUri || ""
        };
      });
      if (S.page === "set") renderSet();
      return cfg;
    });
  }

  function serverLabel() {
    var s = S.servers.filter(function (x) { return x.key === S.server; })[0];
    return s ? s.label : S.server;
  }
  function regionId() {
    return S.server === "shuguang" ? 10000016 : 10000002;
  }
  function regionName() {
    return S.server === "shuguang" ? "曙光" : (S.server === "tranquility" ? "宁静" : "晨曦");
  }
  function currentSystemId() {
    return S.server === "shuguang" ? 30001363 : 30000142;
  }

  /* ================================================================ *
   * 页面切换
   * ================================================================ */
  var PAGE_INIT = {
    char: renderChar,
    market: renderMarket,
    industry: renderIndustry,
    manuf: function () { status("bpStatus", ""); },
    sell: renderSell,
    refine: renderRefine,
    set: renderSet
  };

  function switchPage(key) {
    S.page = key;
    $$("#nav button").forEach(function (b) {
      b.classList.toggle("on", b.dataset.page === key);
    });
    $$(".page").forEach(function (p) {
      p.classList.toggle("on", p.id === "page-" + key);
    });
    if (PAGE_INIT[key]) {
      try { PAGE_INIT[key](); } catch (e) {
        console.error(e);
      }
    }
  }

  /* ================================================================ *
   * 初始化
   * ================================================================ */
  function init() {
    // 事件绑定
    $$("#nav button").forEach(function (b) {
      b.addEventListener("click", function () { switchPage(b.dataset.page); });
    });
    $("#mktSearchBtn").addEventListener("click", doMarketSearch);
    $("#mktSearch").addEventListener("keydown", function (e) {
      if (e.key === "Enter") doMarketSearch();
    });
    $("#mktFavBtn").addEventListener("click", function () {
      var q = $("#mktSearch").value.trim();
      if (!q) { toast("请先查询物品", "err"); return; }
      if (S.fav.indexOf(q) >= 0) { toast("已在收藏中"); return; }
      S.fav.push(q);
      renderMarket();
      toast("已收藏「" + q + "」", "ok");
    });
    $$("#marketSeg button").forEach(function (b) {
      b.addEventListener("click", function () {
        $$("#marketSeg button").forEach(function (x) { x.classList.toggle("on", x === b); });
        if ($("#mktSearch").value.trim()) doMarketSearch();
      });
    });
    $("#bpSearchBtn").addEventListener("click", doBpSearch);
    $("#bpSearch").addEventListener("keydown", function (e) {
      if (e.key === "Enter") doBpSearch();
    });

    // 服务器切换
    // ★ 暴露为 cfgReady，供下面的档案加载链复用（保证只调一次）
    var cfgReady = loadConfig().then(function (cfg) {
      var sel = $("#serverSel");
      sel.innerHTML = "";
      S.servers.forEach(function (sv) {
        sel.appendChild(el("button", {
          class: sv.key === S.server ? "on" : "",
          text: sv.short,
          title: sv.label,
          onclick: function () {
            S.server = sv.key;
            $$("#serverSel button").forEach(function (b) { b.classList.toggle("on", b.text === sv.short); });
            renderChar();
            renderSell();
            renderIndustry();
          }
        }));
      });
      // 税率参数注入（与 Node 内核同源）
      return fetch("data/sde/tax_config.json").then(function (r) { return r.json(); })
        .then(function (tax) {
          window.EveCalc.setTaxConfig({
            salesTax: tax.salesTax.base,
            brokerFee: tax.brokerFee.base,
            brokerFeePerLevel: Math.abs(tax.brokerFee.perLevel),
            brokerFeeMin: tax.brokerFee.floor,
            piImportExportBase: tax.planetaryTax.base,
            piTaxPerLevel: Math.abs(tax.planetaryTax.perLevel)
          });
        });
    }).catch(function (e) {
      toast("加载配置失败：" + e.message, "err");
    });

    // 加载角色档案
    // ★ 依赖 loadConfig 先完成：S.servers 由它填充，否则 renderChar 时
    //   服务器列表还是空的，授权按钮不会渲染出来。
    //   复用同一个 promise（不另起一次），避免两条链并发时
    //   后到的 renderChar() 把刚打开的手动授权面板清空。
    cfgReady.then(function () {
      return api("/api/profiles");
    }).then(function (j) {
      S.profiles = (j && j.profiles) || [];
      if (S.profiles.length) {
        // ★ 用本地档案恢复角色 —— 令牌过期后数据依然可用
        restoreFromProfile(S.profiles[0]);
      }
      renderChar();
      renderSell();
    }).catch(function () {
      renderChar();
    });

    // 预载基础数据表
    Promise.all([table("item_names"), table("item_names_en")]).catch(function () { });

    // 版本号
    fetch("/healthz").then(function (r) { return r.json(); }).then(function (h) {
      if (h.version) $("#ver").textContent = "v" + h.version;
    }).catch(function () { });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
