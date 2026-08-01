# OpenAdult 生产环境 环境变量模板

复制以下内容到你的 `.env` 文件中，并填写实际值。

```bash
# === 数据库 ===
DATABASE_URL=mysql://user:password@host:3306/openadult?ssl={"rejectUnauthorized":true}

# === 认证 ===
JWT_SECRET=your-super-secret-jwt-key-at-least-32-chars
VITE_APP_ID=your-manus-app-id
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://id.manus.im

# === 所有者信息 ===
OWNER_OPEN_ID=your-owner-open-id
OWNER_NAME=your-name

# === Manus API ===
BUILT_IN_FORGE_API_URL=https://forge.manus.im
BUILT_IN_FORGE_API_KEY=your-forge-api-key
VITE_FRONTEND_FORGE_API_URL=https://forge.manus.im
VITE_FRONTEND_FORGE_API_KEY=your-frontend-forge-api-key

# === LLM 模型 ===
HERETIC_LLM_MODEL=heretic-claude-3-5-sonnet

# === 分析 ===
VITE_ANALYTICS_ENDPOINT=https://analytics.manus.im
VITE_ANALYTICS_WEBSITE_ID=your-website-id

# === 应用信息 ===
VITE_APP_TITLE=OpenAdult
VITE_APP_LOGO=https://your-cdn.com/logo.png

# === CDN / HLS ===
CDN_BASE_URL=https://cdn.openadult.com
HLS_MODE=real
# HLS_MODE=pseudo  # 开发环境使用此值

# === S3 存储 ===
S3_BUCKET=openadult-media
S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key

# === 管理员 ===
ADMIN_API_KEY=your-admin-api-key-for-internal-services
ALLOWED_ORIGINS=openadult.com,cdn.openadult.com

# === Cloudflare (域名轮换) ===
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-cloudflare-zone-id

# === Telegram 通知 ===
TG_BOT_TOKEN=your-telegram-bot-token
TG_CHANNEL_ID=@openadult_updates

# === 源站 IP ===
ORIGIN_IP=your-server-public-ip

# === 域名池 (JSON数组) ===
DOMAIN_POOL=["openadult.com","openadult.net","oa-video.com","oa-stream.net"]

# === 监控 ===
GRAFANA_PASSWORD=your-grafana-admin-password

# === 开发环境 ===
NODE_ENV=production
PORT=3000
```

## 环境变量说明

| 变量名 | 必须 | 说明 |
|--------|------|------|
| DATABASE_URL | ✅ | MySQL/TiDB 连接字符串 |
| JWT_SECRET | ✅ | JWT 签名密钥 (≥32字符) |
| VITE_APP_ID | ✅ | Manus OAuth App ID |
| OAUTH_SERVER_URL | ✅ | Manus OAuth 服务器地址 |
| VITE_OAUTH_PORTAL_URL | ✅ | Manus 登录门户地址 |
| OWNER_OPEN_ID | ✅ | 所有者 OpenID |
| OWNER_NAME | ✅ | 所有者名称 |
| BUILT_IN_FORGE_API_URL | ✅ | Manus Forge API 地址 |
| BUILT_IN_FORGE_API_KEY | ✅ | Manus Forge API 密钥 |
| VITE_FRONTEND_FORGE_API_URL | ✅ | 前端 Forge API 地址 |
| VITE_FRONTEND_FORGE_API_KEY | ✅ | 前端 Forge API 密钥 |
| HERETIC_LLM_MODEL | ✅ | 无审查 LLM 模型名称 |
| VITE_ANALYTICS_ENDPOINT | ✅ | 分析服务端点 |
| VITE_ANALYTICS_WEBSITE_ID | ✅ | 分析网站 ID |
| VITE_APP_TITLE | ✅ | 应用标题 |
| VITE_APP_LOGO | ✅ | 应用 Logo URL |
| CDN_BASE_URL | ✅ | CDN 基础URL (生产环境) |
| HLS_MODE | ✅ | `real` (生产) 或 `pseudo` (开发) |
| S3_BUCKET | ✅ | S3 存储桶名 |
| S3_ENDPOINT | ✅ | S3 端点URL |
| AWS_ACCESS_KEY_ID | ✅ | AWS 访问密钥 ID |
| AWS_SECRET_ACCESS_KEY | ✅ | AWS 秘密访问密钥 |
| ADMIN_API_KEY | ✅ | 内部服务间通信密钥 |
| CF_API_TOKEN | ⚠️ | Cloudflare API (域名轮换需要) |
| TG_BOT_TOKEN | ⚠️ | Telegram Bot (通知需要) |
| ORIGIN_IP | ⚠️ | 源站公网IP (域名轮换需要) |
| NODE_ENV | ✅ | 运行环境 (`production` 或 `development`) |
| PORT | ⚠️ | 应用端口 (默认: 3000) |
