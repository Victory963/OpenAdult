# OpenAdult 完整部署保姆级教程

> 本教程面向网络初学者，从零开始手把手教你如何将 OpenAdult 部署到生产环境。
> 包含：购买服务器、注册域名、配置 CDN、部署代码的全部流程。

---

## 目录

1. [前期准备：你需要什么](#1-前期准备你需要什么)
2. [第一步：购买服务器 (VPS)](#2-第一步购买服务器-vps)
3. [第二步：购买域名](#3-第二步购买域名)
4. [第三步：注册 Cloudflare (CDN + DNS)](#4-第三步注册-cloudflare-cdn--dns)
5. [第四步：注册存储服务 (Backblaze B2)](#5-第四步注册存储服务-backblaze-b2)
6. [第五步：注册 Manus 账号 (OAuth + LLM)](#6-第五步注册-manus-账号-oauth--llm)
7. [第六步：连接服务器 (SSH)](#7-第六步连接服务器-ssh)
8. [第七步：上传代码到服务器](#8-第七步上传代码到服务器)
9. [第八步：配置环境变量](#9-第八步配置环境变量)
10. [第九步：一键部署](#10-第九步一键部署)
11. [第十步：配置域名解析](#11-第十步配置域名解析)
12. [第十一步：验证部署](#12-第十一步验证部署)
13. [日常运维](#13-日常运维)
14. [常见问题 FAQ](#14-常见问题-faq)

---

## 1. 前期准备：你需要什么

### 费用预算

| 项目 | 月费用 | 说明 |
|------|--------|------|
| VPS 服务器 | $30-80/月 | 推荐 8核32G |
| 域名 | $10-50/年 | 推荐 .com 或 .net |
| Cloudflare | 免费 | 免费计划足够 |
| Backblaze B2 | $5-20/月 | 按存储量计费 |
| Manus 账号 | 按使用量 | OAuth + LLM 服务 |

### 推荐配置

- **操作系统**: Ubuntu 22.04 LTS (64位)
- **CPU**: 8核以上
- **内存**: 32GB 以上
- **硬盘**: 500GB SSD 以上
- **带宽**: 1Gbps 以上
- **地区**: 荷兰/卢森堡/罗马尼亚 (抗 DMCA)

---

## 2. 第一步：购买服务器 (VPS)

### 推荐服务商

| 服务商 | 价格 | 地区 | 特点 |
|--------|------|------|------|
| Hetzner | €30-60/月 | 德国/芬兰 | 性价比高 |
| OVH | €40-80/月 | 法国/加拿大 | 抗投诉 |
| BuyVM | $30-50/月 | 卢森堡 | 抗 DMCA |
| Vultr | $40-80/月 | 全球 | 按小时计费 |

### 以 Hetzner 为例注册购买

**步骤 1: 注册账号**

1. 打开浏览器，访问 https://www.hetzner.com
2. 点击右上角 "Sign Up" (注册)
3. 填写邮箱和密码
4. 验证邮箱 (查看收件箱，点击验证链接)
5. 完善个人信息 (姓名、地址)
6. 绑定信用卡或 PayPal

**步骤 2: 购买服务器**

1. 登录后，进入 "Cloud" 控制面板
2. 点击 "Add Server" (添加服务器)
3. 选择配置:
   - **Location**: Falkenstein (德国) 或 Helsinki (芬兰)
   - **Image**: Ubuntu 22.04
   - **Type**: CPX41 (8核16G) 或 CCX33 (8核32G)
   - **Volume**: 添加 500GB 额外存储
   - **SSH Key**: 上传你的 SSH 公钥 (后面会讲如何生成)
4. 点击 "Create & Buy Now"
5. 等待 30 秒，服务器创建完成
6. 记录下服务器的 **IP 地址** (例如: `65.108.xxx.xxx`)

### 生成 SSH 密钥 (如果你没有)

**Windows 用户:**

1. 下载并安装 PuTTYgen: https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html
2. 打开 PuTTYgen
3. 点击 "Generate" (生成)
4. 随机移动鼠标直到进度条完成
5. 设置密码 (Key passphrase)
6. 点击 "Save private key" 保存私钥 (例如: `openadult.ppk`)
7. 复制上方文本框中的公钥内容

**Mac/Linux 用户:**

```bash
# 在终端中执行
ssh-keygen -t ed25519 -C "openadult-server"

# 按回车使用默认路径
# 设置密码 (可选)

# 查看公钥
cat ~/.ssh/id_ed25519.pub
```

---

## 3. 第二步：购买域名

### 推荐域名注册商

| 注册商 | 价格 | 特点 |
|--------|------|------|
| Namecheap | $8-12/年 | 便宜，隐私保护免费 |
| Porkbun | $8-10/年 | 最便宜 |
| Cloudflare Registrar | $8-10/年 | 成本价，无加价 |
| GoDaddy | $12-20/年 | 最知名 |

### 以 Namecheap 为例

**步骤 1: 注册账号**

1. 访问 https://www.namecheap.com
2. 点击右上角 "Sign Up"
3. 填写用户名、邮箱、密码
4. 验证邮箱

**步骤 2: 搜索并购买域名**

1. 在首页搜索框输入你想要的域名 (例如: `mysite.com`)
2. 查看可用域名列表
3. 选择一个域名，点击 "Add to Cart"
4. 进入购物车，确认:
   - **WhoisGuard**: 开启 (免费隐私保护)
   - **Auto-Renew**: 建议开启 (自动续费)
5. 选择支付方式 (信用卡/PayPal/加密货币)
6. 完成购买

**建议**: 购买 3-5 个域名用于域名轮换 (防封锁)，例如:
- `mysite.com`
- `mysite.net`
- `mysite-video.com`
- `my-stream.net`

---

## 4. 第三步：注册 Cloudflare (CDN + DNS)

Cloudflare 提供免费的 CDN 加速和 DNS 管理，还能隐藏你的服务器真实 IP。

**步骤 1: 注册账号**

1. 访问 https://www.cloudflare.com
2. 点击 "Sign Up"
3. 输入邮箱和密码
4. 验证邮箱

**步骤 2: 添加你的域名**

1. 登录 Cloudflare 控制面板
2. 点击 "Add a Site" (添加站点)
3. 输入你的域名 (例如: `mysite.com`)
4. 选择 "Free" 计划
5. Cloudflare 会扫描现有 DNS 记录
6. 点击 "Continue"

**步骤 3: 修改域名的 NS 服务器**

Cloudflare 会给你两个 NS 服务器地址，例如:
```
ns1.cloudflare.com
ns2.cloudflare.com
```

回到你的域名注册商 (Namecheap):
1. 进入域名管理
2. 找到 "Nameservers" 设置
3. 选择 "Custom DNS"
4. 输入 Cloudflare 给的两个 NS 地址
5. 保存

等待 5-30 分钟，Cloudflare 会显示 "Active" (激活)。

**步骤 4: 获取 API Token**

1. 在 Cloudflare 控制面板，点击右上角头像
2. 选择 "My Profile"
3. 点击左侧 "API Tokens"
4. 点击 "Create Token"
5. 选择 "Edit zone DNS" 模板
6. 配置:
   - Zone Resources: 选择你的域名
   - Permissions: Zone - DNS - Edit
7. 点击 "Continue to summary" → "Create Token"
8. **复制并保存 Token** (只显示一次!)

**步骤 5: 获取 Zone ID**

1. 进入你的域名控制面板
2. 在右侧 "API" 区域
3. 找到 "Zone ID"
4. 复制并保存

**步骤 6: 创建 Origin Certificate (SSL 证书)**

1. 进入域名控制面板
2. 点击左侧 "SSL/TLS"
3. 点击 "Origin Server"
4. 点击 "Create Certificate"
5. 保持默认设置 (RSA 2048, 15年有效期)
6. 点击 "Create"
7. **复制证书内容** → 保存为 `origin.pem`
8. **复制私钥内容** → 保存为 `origin-key.pem`

> **重要**: 私钥只显示一次，务必保存好!

---

## 5. 第四步：注册存储服务 (Backblaze B2)

Backblaze B2 是一个便宜的 S3 兼容对象存储服务，用于存储视频文件。

**步骤 1: 注册账号**

1. 访问 https://www.backblaze.com/b2/cloud-storage.html
2. 点击 "Sign Up Free"
3. 填写邮箱和密码
4. 验证邮箱

**步骤 2: 创建存储桶 (Bucket)**

1. 登录后，点击左侧 "Buckets"
2. 点击 "Create a Bucket"
3. 配置:
   - **Bucket Name**: `openadult-media` (必须全局唯一)
   - **Files in Bucket are**: Private
4. 点击 "Create a Bucket"

**步骤 3: 获取 API 密钥**

1. 点击左侧 "App Keys"
2. 点击 "Add a New Application Key"
3. 配置:
   - **Name**: `openadult-key`
   - **Allow access to Bucket(s)**: 选择你创建的桶
   - **Type of Access**: Read and Write
4. 点击 "Create New Key"
5. **记录以下信息** (只显示一次):
   - `keyID` → 这是你的 `AWS_ACCESS_KEY_ID`
   - `applicationKey` → 这是你的 `AWS_SECRET_ACCESS_KEY`

**步骤 4: 获取 S3 端点**

1. 进入 Bucket 详情页
2. 找到 "Endpoint"
3. 格式为: `s3.us-west-002.backblazeb2.com`
4. 完整 URL: `https://s3.us-west-002.backblazeb2.com`

---

## 6. 第五步：注册 Manus 账号 (OAuth + LLM)

Manus 提供 OAuth 认证和 LLM (大语言模型) 服务。

**步骤 1: 注册账号**

1. 访问 https://manus.im
2. 注册账号并登录

**步骤 2: 获取 App ID 和 API Key**

1. 进入开发者控制面板
2. 创建一个新应用
3. 记录:
   - `VITE_APP_ID`: 应用 ID
   - `BUILT_IN_FORGE_API_KEY`: Forge API 密钥
   - `VITE_FRONTEND_FORGE_API_KEY`: 前端 Forge API 密钥
   - `OWNER_OPEN_ID`: 你的 OpenID
   - `OWNER_NAME`: 你的用户名

---

## 7. 第六步：连接服务器 (SSH)

### Windows 用户 (使用 PuTTY)

1. 下载 PuTTY: https://www.chiark.greenend.org.uk/~sgtatham/putty/latest.html
2. 打开 PuTTY
3. 在 "Host Name" 输入你的服务器 IP
4. 在左侧 Connection → SSH → Auth → Credentials
5. 选择你之前保存的私钥文件 (.ppk)
6. 回到 Session，点击 "Open"
7. 用户名输入: `root`

### Mac/Linux 用户 (使用终端)

```bash
# 连接服务器
ssh root@你的服务器IP

# 如果使用自定义密钥
ssh -i ~/.ssh/id_ed25519 root@你的服务器IP
```

### 首次连接后的安全设置

```bash
# 创建普通用户 (不要一直用 root)
adduser openadult
usermod -aG sudo openadult

# 切换到新用户
su - openadult
```

---

## 8. 第七步：上传代码到服务器

### 方法一：直接上传压缩包 (推荐新手)

**Windows 用户 (使用 WinSCP):**

1. 下载 WinSCP: https://winscp.net
2. 打开 WinSCP
3. 输入服务器 IP、用户名 (root)、密钥文件
4. 连接后，将 `openadult-deploy-complete.tar.gz` 拖到 `/opt/` 目录

**Mac/Linux 用户:**

```bash
# 在本地终端执行
scp openadult-deploy-complete.tar.gz root@你的服务器IP:/opt/
```

**在服务器上解压:**

```bash
cd /opt
tar -xzf openadult-deploy-complete.tar.gz
mv openadult-deploy openadult
cd openadult
```

### 方法二：使用 Git (推荐有经验的用户)

```bash
# 在服务器上执行
cd /opt
git clone <你的仓库地址> openadult
cd openadult
```

---

## 9. 第八步：配置环境变量

这是最重要的一步，需要把之前注册的所有服务信息填入配置文件。

### 创建 .env 文件

```bash
cd /opt/openadult
nano .env
```

### 填写以下内容

```bash
# === 数据库 (使用 Manus 提供的数据库) ===
DATABASE_URL=mysql://user:password@host:3306/openadult?ssl={"rejectUnauthorized":true}

# === 认证 (从 Manus 控制面板获取) ===
JWT_SECRET=这里填一个32位以上的随机字符串
VITE_APP_ID=从Manus控制面板获取
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://id.manus.im

# === 所有者信息 ===
OWNER_OPEN_ID=你的ManusOpenID
OWNER_NAME=你的用户名

# === Manus API ===
BUILT_IN_FORGE_API_URL=https://forge.manus.im
BUILT_IN_FORGE_API_KEY=从Manus控制面板获取
VITE_FRONTEND_FORGE_API_URL=https://forge.manus.im
VITE_FRONTEND_FORGE_API_KEY=从Manus控制面板获取

# === LLM 模型 ===
HERETIC_LLM_MODEL=heretic-claude-3-5-sonnet

# === 分析 ===
VITE_ANALYTICS_ENDPOINT=https://analytics.manus.im
VITE_ANALYTICS_WEBSITE_ID=从Manus控制面板获取

# === 应用信息 ===
VITE_APP_TITLE=OpenAdult
VITE_APP_LOGO=https://你的CDN地址/logo.png

# === CDN / HLS ===
CDN_BASE_URL=https://cdn.你的域名.com
HLS_MODE=real

# === S3 存储 (从 Backblaze B2 获取) ===
S3_BUCKET=openadult-media
S3_ENDPOINT=https://s3.us-west-002.backblazeb2.com
AWS_ACCESS_KEY_ID=从BackblazeB2获取的keyID
AWS_SECRET_ACCESS_KEY=从BackblazeB2获取的applicationKey

# === 管理员 ===
ADMIN_API_KEY=这里填一个随机字符串作为内部通信密钥
ALLOWED_ORIGINS=你的域名1.com,你的域名2.com

# === Cloudflare (域名轮换) ===
CF_API_TOKEN=从Cloudflare获取的APIToken
CF_ZONE_ID=从Cloudflare获取的ZoneID

# === Telegram 通知 (可选) ===
TG_BOT_TOKEN=从BotFather获取
TG_CHANNEL_ID=@你的频道名

# === 源站 IP ===
ORIGIN_IP=你的服务器公网IP

# === 域名池 ===
DOMAIN_POOL=["域名1.com","域名2.com","域名3.com"]

# === 监控 ===
GRAFANA_PASSWORD=设置一个Grafana管理密码

# === 运行环境 ===
NODE_ENV=production
PORT=3000
```

### 如何生成随机字符串

```bash
# 生成 JWT_SECRET (32位随机字符串)
openssl rand -hex 32

# 生成 ADMIN_API_KEY
openssl rand -hex 16
```

### 保存文件

在 nano 编辑器中:
- `Ctrl + O` → 保存
- `Ctrl + X` → 退出

---

## 10. 第九步：一键部署

### 执行部署脚本

```bash
cd /opt/openadult
sudo bash deploy/scripts/deploy.sh
```

### 部署脚本会自动完成以下操作

1. 安装系统依赖 (curl, wget, git, ufw, fail2ban)
2. 安装 Docker 和 Docker Compose
3. 安装 Node.js 22 和 pnpm
4. 配置防火墙 (仅开放 22, 80, 443 端口)
5. 构建应用 (前端 + 后端)
6. 配置 SSL 证书
7. 启动 Docker 容器
8. 验证部署状态

### 预期输出

```
=========================================
  OpenAdult 一键部署脚本
=========================================

[1/8] 安装系统依赖...
[2/8] 安装 Docker...
[3/8] 安装 Node.js 22...
[4/8] 配置防火墙...
[5/8] 构建应用...
[6/8] 配置 SSL 证书...
[7/8] 启动 Docker 服务...
[8/8] 验证部署...

✅ API Server: 正常
✅ Nginx: 正常
✅ Redis: 正常

=========================================
  部署完成!
=========================================
```

### 如果部署失败

```bash
# 查看详细日志
docker compose -f /opt/openadult/deploy/docker/docker-compose.yml logs

# 重新构建并启动
cd /opt/openadult
pnpm build
cd deploy/docker
docker compose --env-file /opt/openadult/.env up -d
```

---

## 11. 第十步：配置域名解析

### 在 Cloudflare 中添加 DNS 记录

1. 登录 Cloudflare 控制面板
2. 选择你的域名
3. 点击左侧 "DNS"
4. 添加以下记录:

| 类型 | 名称 | 内容 | 代理状态 |
|------|------|------|---------|
| A | @ | 你的服务器IP | 已代理 (橙色云朵) |
| A | www | 你的服务器IP | 已代理 |
| A | cdn | 你的服务器IP | 已代理 |

5. 对每个域名重复以上操作

### 配置 SSL/TLS 模式

1. 在 Cloudflare 控制面板
2. 点击 "SSL/TLS"
3. 选择 "Full (strict)" 模式

### 上传 Origin Certificate 到服务器

```bash
# 将之前保存的证书上传到服务器
# 方法1: 使用 nano 直接粘贴
sudo mkdir -p /etc/nginx/ssl
sudo nano /etc/nginx/ssl/origin.pem
# 粘贴证书内容，保存

sudo nano /etc/nginx/ssl/origin-key.pem
# 粘贴私钥内容，保存

# 设置权限
sudo chmod 600 /etc/nginx/ssl/*
```

### 重启 Nginx 容器

```bash
cd /opt/openadult/deploy/docker
docker compose restart nginx
```

---

## 12. 第十一步：验证部署

### 浏览器访问

1. 打开浏览器
2. 输入 `https://你的域名.com`
3. 应该能看到 OpenAdult 首页

### 检查各服务状态

```bash
# 检查所有容器状态
cd /opt/openadult/deploy/docker
docker compose ps

# 预期输出: 所有容器状态为 "Up (healthy)"
```

### 检查 API

```bash
curl https://你的域名.com/health
# 预期输出: {"status":"ok","timestamp":"..."}
```

### 访问管理面板

1. 打开 `https://你的域名.com/admin-login`
2. 使用管理员账号登录
3. 确认能正常访问

### 访问监控面板

1. 打开 `http://你的服务器IP:3100`
2. 用户名: `admin`
3. 密码: 你在 .env 中设置的 `GRAFANA_PASSWORD`

---

## 13. 日常运维

### 查看日志

```bash
# 查看应用日志
cd /opt/openadult/deploy/docker
docker compose logs -f app

# 查看 Nginx 日志
docker compose logs -f nginx

# 查看转码服务日志
docker compose logs -f transcoder

# 查看最近1小时的日志
docker compose logs --since 1h app
```

### 重启服务

```bash
# 重启所有服务
docker compose restart

# 重启单个服务
docker compose restart app
docker compose restart nginx
```

### 更新代码

```bash
cd /opt/openadult

# 如果使用 Git
git pull origin main

# 重新构建
pnpm install --frozen-lockfile
pnpm build

# 重启容器
cd deploy/docker
docker compose --env-file /opt/openadult/.env up -d --build app
```

### 备份

```bash
# 备份配置
cp /opt/openadult/.env /opt/openadult/.env.backup.$(date +%Y%m%d)

# 备份数据库 (如果使用本地数据库)
docker compose exec db mysqldump -u root -p openadult > backup_$(date +%Y%m%d).sql
```

### 监控磁盘空间

```bash
# 查看磁盘使用情况
df -h

# 清理 Docker 无用镜像
docker system prune -f
```

---

## 14. 常见问题 FAQ

### Q: 部署脚本报错 "Permission denied"

**A**: 确保使用 sudo 执行:
```bash
sudo bash deploy/scripts/deploy.sh
```

### Q: 网站打不开，显示 "502 Bad Gateway"

**A**: 应用容器可能没有正常启动:
```bash
cd /opt/openadult/deploy/docker
docker compose logs app
# 查看错误信息

# 常见原因: DATABASE_URL 配置错误
# 解决: 检查 .env 中的数据库连接字符串
```

### Q: 网站打不开，显示 "SSL Error"

**A**: SSL 证书配置问题:
1. 确认 Cloudflare SSL 模式设为 "Full (strict)"
2. 确认 Origin Certificate 已正确放置到 `/etc/nginx/ssl/`
3. 重启 Nginx: `docker compose restart nginx`

### Q: 视频无法播放

**A**: 检查以下几点:
1. HLS_MODE 是否设为 `real`
2. S3 存储配置是否正确
3. CDN_BASE_URL 是否指向正确的 CDN 地址
4. 转码服务是否正常: `docker compose logs transcoder`

### Q: 域名被封了怎么办

**A**: 域名轮换系统会自动处理:
1. 检查 Telegram 频道获取新域名
2. 手动触发轮换:
```bash
docker compose exec domain-rotator python -c "from domain_rotator import *; DomainRotator(CONFIG).check_and_rotate()"
```

### Q: 如何添加新域名到轮换池

**A**:
1. 在域名注册商购买新域名
2. 在 Cloudflare 添加新域名
3. 修改 .env 中的 `DOMAIN_POOL`
4. 重启 domain-rotator: `docker compose restart domain-rotator`

### Q: 内存不足怎么办

**A**: 可以减少资源限制:
```bash
# 编辑 docker-compose.yml
# 减少 transcoder 的内存限制
# 或者升级服务器配置
```

### Q: 如何查看网站访问统计

**A**: 
1. 访问 Grafana: `http://服务器IP:3100`
2. 或者在管理面板中查看

### Q: 如何创建 Telegram Bot

**A**:
1. 在 Telegram 中搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示设置 Bot 名称
4. 获取 Bot Token
5. 创建一个频道，将 Bot 添加为管理员
6. 频道 ID 格式: `@你的频道名`

---

## 附录 A: 目录结构说明

```
openadult/
├── client/              ← 前端代码 (React + Tailwind)
│   ├── src/
│   │   ├── pages/       ← 页面组件
│   │   ├── components/  ← 通用组件
│   │   └── App.tsx      ← 路由配置
│   └── index.html       ← 入口 HTML
├── server/              ← 后端代码 (Express + tRPC)
│   ├── _core/           ← 框架核心 (不要修改)
│   ├── routers/         ← API 路由
│   ├── db.ts            ← 数据库操作
│   └── storage.ts       ← 存储操作
├── drizzle/             ← 数据库迁移
│   └── schema.ts        ← 数据库表定义
├── deploy/              ← 部署配置
│   ├── docker/          ← Docker 配置
│   ├── nginx/           ← Nginx 配置
│   ├── openresty/       ← CDN 广告拼接
│   ├── ffmpeg/          ← 转码脚本
│   ├── anti-block/      ← 反封锁系统
│   ├── monitoring/      ← 监控配置
│   ├── scripts/         ← 部署脚本
│   └── docs/            ← 文档
├── package.json         ← 项目依赖
├── .env                 ← 环境变量 (需要自己创建)
└── .dockerignore        ← Docker 构建忽略文件
```

## 附录 B: 端口说明

| 端口 | 服务 | 说明 |
|------|------|------|
| 80 | Nginx | HTTP (重定向到 HTTPS) |
| 443 | Nginx | HTTPS (主站) |
| 3000 | App | Node.js API 服务器 |
| 3100 | Grafana | 监控面板 |
| 6379 | Redis | 缓存服务 |
| 8080 | OpenResty | CDN 广告拼接 |
| 9090 | Prometheus | 指标收集 |

## 附录 C: 安全建议

1. **永远不要** 将 .env 文件提交到 Git
2. **定期更新** 系统和 Docker 镜像
3. **启用** Cloudflare 的 "Under Attack" 模式 (遭受攻击时)
4. **定期备份** 数据库和配置文件
5. **监控** 服务器资源使用情况
6. **使用强密码** 所有服务都使用随机生成的强密码

---

**文档版本**: v2.0  
**最后更新**: 2026年5月30日  
**适用版本**: OpenAdult Latest
