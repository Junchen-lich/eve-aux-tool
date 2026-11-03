#!/usr/bin/env bash
# 国服授权一键验证
#
# 用途：打开网易授权页 → 你完成登录与授权 → 自动验证全链路
#       （令牌交换 → 真实技能拉取 → 中文映射 → 档案落盘）
#
# 用法：bash scripts/verify_auth.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8657}"
URL_FILE="/tmp/eve_auth_url_$$.txt"

echo "=============================================="
echo " EVE 辅助工具 —— 国服授权端到端验证"
echo "=============================================="
echo

# 1. 检查服务是否在跑
if ! curl -s --noproxy '*' -m 5 "http://127.0.0.1:${PORT}/api/config" > /dev/null 2>&1; then
  echo "[1/4] 本地服务未运行，正在启动..."
  NO_AUTO_OPEN=1 node server.js > /tmp/eveaux_verify.log 2>&1 &
  sleep 3
  if curl -s --noproxy '*' -m 5 "http://127.0.0.1:${PORT}/api/config" > /dev/null 2>&1; then
    echo "      ✓ 已启动（若端口被占用会自动回退，见启动日志）"
  else
    echo "      ✗ 启动失败，请查看 /tmp/eveaux_verify.log"
    exit 1
  fi
else
  echo "[1/4] 本地服务已在运行"
fi

# 2. 生成授权 URL
echo "[2/4] 生成授权链接..."
AUTH_URL=$(node -e "
(async()=>{
  const r = await fetch('http://127.0.0.1:${PORT}/sso/start?server=serenity&scope=esi-skills.read_skills.v1',{redirect:'manual'});
  const loc = r.headers.get('location');
  if(!loc){ console.error('生成失败'); process.exit(1); }
  console.log(loc);
})();
" 2>/dev/null)
if [ -z "$AUTH_URL" ]; then
  echo "      ✗ 授权链接生成失败"
  exit 1
fi
echo "$AUTH_URL" > "$URL_FILE"
echo "      ✓ 已生成"

# 3. 打开浏览器
echo "[3/4] 打开浏览器..."
CHROME=""
for c in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
         "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
         "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
  [ -f "$c" ] && CHROME="$c" && break
done
if [ -n "$CHROME" ]; then
  powershell -NoProfile -Command "Start-Process '$CHROME' -ArgumentList '$AUTH_URL'" 2>/dev/null
  echo "      ✓ 已打开系统浏览器"
else
  echo "      ! 未找到 Chrome/Edge，请手动复制链接到浏览器打开："
  echo "        $AUTH_URL"
fi

echo
echo "=============================================="
echo " 请在浏览器中完成："
echo "   1) 登录网易账号"
echo "   2) 同意授权（仅申请「读取角色技能」1 项权限）"
echo ""
echo " 授权后会自动跳回本地回调，验证结果实时输出…"
echo "=============================================="
echo

# 4. 监听验证结果
node scripts/watch_auth.js
RC=$?

rm -f "$URL_FILE"
echo
if [ $RC -eq 0 ]; then
  echo "★ 全链路验证通过：授权 → 令牌 → 技能 → 中文映射 → 档案 全部正常"
else
  echo "✗ 验证未完成（退出码 $RC）。请查看上方提示。"
fi
exit $RC
