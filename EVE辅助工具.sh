#!/usr/bin/env bash
# ============================================================
#  EVE 辅助工具 —— 单一入口（macOS / Linux / WSL）
#
#  用法：
#    ./EVE辅助工具.sh              交互菜单
#    ./EVE辅助工具.sh start        前台启动
#    ./EVE辅助工具.sh bg           后台启动
#    ./EVE辅助工具.sh stop         停止服务
#    ./EVE辅助工具.sh restart      重启
#    ./EVE辅助工具.sh status       查看状态
#    ./EVE辅助工具.sh open         打开界面
#    ./EVE辅助工具.sh logs         查看日志
#    ./EVE辅助工具.sh test         运行自检
# ============================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  [X] 未找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org"
  echo
  exit 1
fi

exec node scripts/launch.js "$@"
