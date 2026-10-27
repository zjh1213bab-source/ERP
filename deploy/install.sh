#!/usr/bin/env bash
# 跳色科技 ERP —— Linux 一键部署脚本（在项目根目录或 deploy 目录执行均可）
# 用法：bash deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "=============================================="
echo "  跳色科技 ERP 一键部署"
echo "  项目目录: $APP_DIR"
echo "=============================================="

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 node，请先安装 Node.js 18+（推荐 20/22 LTS）"
  exit 1
fi
echo "[环境] node $(node -v)  npm $(npm -v)"

# ---------- 后端 ----------
cd "$APP_DIR/backend"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[提示] 已生成 backend/.env，请务必修改 JWT_SECRET 与 ADMIN_PASSWORD"
fi
echo "[1/4] 安装后端依赖 ..."
npm install --omit=dev --no-audit --no-fund

# ---------- 前端 ----------
cd "$APP_DIR/frontend"
echo "[2/4] 安装前端依赖并构建 ..."
npm install --no-audit --no-fund
npm run build

# ---------- PM2 ----------
cd "$APP_DIR"
mkdir -p backend/logs
echo "[3/4] 启动 PM2 守护 ..."
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 --no-audit --no-fund || true
fi
if command -v pm2 >/dev/null 2>&1; then
  pm2 start deploy/ecosystem.config.js >/dev/null 2>&1 || pm2 restart erp-mindmap-api >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  echo "[4/4] 完成"
else
  echo "[警告] 未安装 PM2，可手动启动：cd backend && node src/server.js"
fi

echo
echo "本机访问:   http://127.0.0.1:3000"
echo "健康检查:   curl http://127.0.0.1:3000/api/health"
echo "Nginx 配置: deploy/nginx.conf（HTTPS 见 deploy/nginx-https.conf）"
echo "上线检查单: deploy/GO-LIVE-CHECKLIST.md"
echo
echo "下一步（服务器上执行一次即可）："
echo "  pm2 startup        # 按提示执行输出的命令，实现开机自启"
