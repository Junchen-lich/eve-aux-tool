#!/usr/bin/env bash
# EVE 辅助工具 —— 服务器部署脚本
#
# 用法：
#   sudo bash deploy/scripts/deploy.sh
#
# 幂等：可重复执行。已存在的文件会备份为 .bak-<时间戳>。
set -euo pipefail

APP_NAME="eve-aux-tool"
APP_DIR="/opt/${APP_NAME}"
APP_USER="eve"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "=============================================="
echo " EVE 辅助工具 —— 部署到专用服务器"
echo "=============================================="
echo "源码目录：${SRC_DIR}"
echo "安装目录：${APP_DIR}"
echo

# ---------- 1. 系统依赖 ----------
echo "[1/7] 检查系统依赖"
if ! command -v node > /dev/null 2>&1; then
  echo "      未安装 Node.js，安装中…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "      Node $(node --version)"
if ! command -v nginx > /dev/null 2>&1; then
  echo "      未安装 Nginx，安装中…"
  apt-get update && apt-get install -y nginx
fi
echo "      Nginx $(nginx -v 2>&1 | sed 's|.*/||')"

# ---------- 2. 服务用户 ----------
echo "[2/7] 准备服务用户"
if ! id -u "${APP_USER}" > /dev/null 2>&1; then
  useradd --system --home-dir "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
  echo "      已创建系统用户 ${APP_USER}"
else
  echo "      用户 ${APP_USER} 已存在"
fi

# ---------- 3. 复制文件 ----------
echo "[3/7] 复制应用文件"
mkdir -p "${APP_DIR}"
# 排除开发期文件与用户数据（用户数据是运行期产物，不能覆盖）
for item in server.js package.json src scripts data index.html README.md .env.example; do
  if [ -e "${SRC_DIR}/${item}" ]; then
    cp -r "${SRC_DIR}/${item}" "${APP_DIR}/"
  fi
done
# 部署资产
mkdir -p "${APP_DIR}/deploy"
cp -r "${SRC_DIR}/deploy/"* "${APP_DIR}/deploy/" 2>/dev/null || true
echo "      已复制到 ${APP_DIR}"

# ---------- 4. 环境变量 ----------
echo "[4/7] 配置环境变量"
ENV_FILE="${APP_DIR}/.env"
if [ -f "${ENV_FILE}" ]; then
  cp "${ENV_FILE}" "${ENV_FILE}.bak-$(date +%Y%m%d%H%M%S)"
  echo "      已存在 .env，备份后保留（不覆盖你的密钥）"
  if [ -f "${SRC_DIR}/.env" ]; then
    cp "${SRC_DIR}/.env" "${ENV_FILE}"
    echo "      已用源码目录的 .env 覆盖"
  fi
else
  cp "${SRC_DIR}/.env.example" "${ENV_FILE}"
  echo "      已从模板创建 .env —— 请务必编辑其中的 BASE_URL 与 EVE_CLIENT_ID"
fi
chmod 600 "${ENV_FILE}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ---------- 5. 目录权限 ----------
echo "[5/7] 设置目录权限"
mkdir -p "${APP_DIR}/用户数据"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}/用户数据"
chmod 700 "${APP_DIR}/用户数据"
echo "      用户数据目录仅 ${APP_USER} 可读写"

# ---------- 6. systemd ----------
echo "[6/7] 安装 systemd 服务"
cp "${SRC_DIR}/deploy/systemd/${APP_NAME}.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable "${APP_NAME}"
systemctl restart "${APP_NAME}"
sleep 2
if systemctl is-active --quiet "${APP_NAME}"; then
  echo "      服务已启动"
else
  echo "      ✗ 启动失败，日志如下："
  journalctl -u "${APP_NAME}" -n 30 --no-pager
  exit 1
fi

# ---------- 7. 健康检查 ----------
echo "[7/7] 健康检查"
HEALTH=$(curl -s --max-time 10 http://127.0.0.1:8657/healthz || echo "")
if echo "${HEALTH}" | grep -q '"ok":true'; then
  echo "      ✓ ${HEALTH}"
else
  echo "      ✗ 健康检查未通过"
  journalctl -u "${APP_NAME}" -n 20 --no-pager
  exit 1
fi

echo
echo "=============================================="
echo " 部署完成"
echo "=============================================="
echo " 后续步骤："
echo "   1. 编辑 ${ENV_FILE}，填入 BASE_URL 与 EVE_CLIENT_ID（国服另填 EVE_CLIENT_ID_CN）"
echo "   2. 配置 Nginx："
echo "      cp ${APP_DIR}/deploy/nginx/${APP_NAME}.conf /etc/nginx/sites-available/"
echo "      ln -s ../sites-available/${APP_NAME}.conf /etc/nginx/sites-enabled/"
echo "      nginx -t && systemctl reload nginx"
echo "   3. 申请证书：certbot --nginx -d 你的域名"
echo "   4. 在 EVE 开发者后台把回调地址登记为 ${APP_DIR}/.env 中 BASE_URL + /sso/callback"
echo
echo " 常用命令："
echo "   systemctl status ${APP_NAME}"
echo "   journalctl -u ${APP_NAME} -f"
echo "   systemctl restart ${APP_NAME}"
echo
