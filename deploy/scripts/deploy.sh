#!/bin/bash
# ============================================================
# OpenAdult 一键部署脚本
# 用途: 在全新服务器上完成完整部署
# 前提: Ubuntu 22.04, root 权限
# ============================================================

set -euo pipefail

echo "========================================="
echo "  OpenAdult 一键部署脚本"
echo "========================================="

# === 检查 root 权限 ===
if [ "$EUID" -ne 0 ]; then
    echo "错误: 请使用 root 权限运行此脚本"
    echo "用法: sudo bash deploy.sh"
    exit 1
fi

# === 检查 .env 文件 ===
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "错误: 未找到 .env 文件"
    echo "请先复制 deploy/docs/env-template.md 中的模板并填写实际值"
    exit 1
fi

# 安全加载 .env 文件 (跳过注释和空行)
set -a
while IFS='=' read -r key value; do
    # 跳过注释和空行
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # 去掉值两端的引号
    value="${value%\"}"
    value="${value#\"}"
    export "$key=$value"
done < "$ENV_FILE"
set +a

# === Step 1: 系统更新 + 基础工具 ===
echo ""
echo "[1/8] 安装系统依赖..."
apt-get update -qq
apt-get install -y -qq \
    curl wget git \
    ufw fail2ban \
    ca-certificates gnupg lsb-release

# === Step 2: 安装 Docker ===
echo "[2/8] 安装 Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# 安装 Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    apt-get install -y -qq docker-compose-plugin
fi

# === Step 3: 安装 Node.js (用于本地构建) ===
echo "[3/8] 安装 Node.js 22..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
    npm install -g pnpm
fi

# === Step 4: 防火墙配置 ===
echo "[4/8] 配置防火墙..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
# 仅允许 Cloudflare IP 访问 80/443 (可选, 需要更复杂的规则)
ufw --force enable

# === Step 5: 构建应用 ===
echo "[5/8] 构建应用..."
cd "$PROJECT_DIR"
pnpm install --frozen-lockfile
pnpm build

# === Step 6: SSL 证书 ===
echo "[6/8] 配置 SSL 证书..."
SSL_DIR="/etc/nginx/ssl"
mkdir -p "$SSL_DIR"

if [ ! -f "$SSL_DIR/origin.pem" ]; then
    echo "警告: SSL 证书未找到!"
    echo "请将 Cloudflare Origin Certificate 放置到:"
    echo "  $SSL_DIR/origin.pem"
    echo "  $SSL_DIR/origin-key.pem"
    echo ""
    echo "获取方式: Cloudflare Dashboard -> SSL/TLS -> Origin Server -> Create Certificate"
    
    # 临时生成自签名证书 (仅用于测试)
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$SSL_DIR/origin-key.pem" \
        -out "$SSL_DIR/origin.pem" \
        -subj "/CN=openadult.com" \
        2>/dev/null
    echo "已生成临时自签名证书 (请尽快替换为 Cloudflare Origin Certificate)"
fi

# === Step 7: 启动 Docker 服务 ===
echo "[7/8] 启动 Docker 服务..."
cd "$PROJECT_DIR/deploy/docker"
docker compose --env-file "$ENV_FILE" up -d

# 等待服务启动
echo "等待服务启动..."
sleep 10

# 检查服务状态
echo ""
echo "服务状态:"
docker compose ps

# === Step 8: 验证部署 ===
echo ""
echo "[8/8] 验证部署..."

# 检查 API
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ API Server: 正常"
else
    echo "❌ API Server: 异常"
fi

# 检查 Nginx
if curl -sf http://localhost/health > /dev/null 2>&1; then
    echo "✅ Nginx: 正常"
else
    echo "❌ Nginx: 异常"
fi

# 检查 Redis
if docker compose exec -T redis redis-cli ping | grep -q PONG; then
    echo "✅ Redis: 正常"
else
    echo "❌ Redis: 异常"
fi

echo ""
echo "========================================="
echo "  部署完成!"
echo "========================================="
echo ""
FIRST_DOMAIN=$(echo "$DOMAIN_POOL" | tr -d '[]"' | cut -d',' -f1)
echo "访问地址: https://$FIRST_DOMAIN"
echo "管理面板: https://$FIRST_DOMAIN/admin"
echo "Grafana:  http://$(hostname -I | awk '{print $1}'):3100"
echo ""
echo "下一步:"
echo "  1. 在 Cloudflare 配置 DNS 指向此服务器"
echo "  2. 替换 SSL 证书为 Cloudflare Origin Certificate"
echo "  3. 配置 Telegram Bot 用于域名轮换通知"
echo "  4. 上传测试视频验证转码流程"
echo ""
