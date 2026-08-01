# OpenAdult 生产环境部署指南

## 目录结构

```
deploy/
├── README.md              ← 本文件
├── docker/
│   ├── docker-compose.yml ← 完整服务编排
│   ├── Dockerfile.app     ← API 服务器镜像
│   ├── Dockerfile.transcoder ← 转码服务镜像
│   └── Dockerfile.rotator ← 域名轮换服务镜像
├── nginx/
│   ├── openadult-main.conf ← 主站 Nginx 配置
│   ├── js-challenge.conf  ← JS Challenge 中间件
│   └── cloudflare-ips.conf ← Cloudflare IP 白名单
├── openresty/
│   ├── openresty-cdn.conf ← CDN 广告拼接节点配置
│   └── lua/
│       ├── ad_stitcher.lua    ← Master Playlist 广告拼接
│       └── variant_stitcher.lua ← Variant Playlist 广告拼接
├── ffmpeg/
│   ├── transcode_hls.sh   ← 多码率 HLS 转码脚本
│   ├── transcode_ad.sh    ← 广告素材转码脚本
│   └── transcode_watcher.sh ← 自动转码监控服务
├── anti-block/
│   ├── domain_rotator.py  ← 域名轮换系统
│   └── challenge.html     ← JS Challenge 页面
├── monitoring/
│   └── prometheus.yml     ← Prometheus 监控配置
├── scripts/
│   └── deploy.sh          ← 一键部署脚本
└── docs/
    └── env-template.md    ← 环境变量模板
```

## 快速部署

### 前提条件

- Ubuntu 22.04 服务器 (推荐: 荷兰/卢森堡, 抗 DMCA)
- 至少 8核 32GB RAM (API + 转码)
- 10+ 域名 (用于轮换)
- Cloudflare 账号
- Backblaze B2 账号 (S3 兼容存储)
- Telegram Bot (用于通知)

### 部署步骤

```bash
# 1. 克隆代码
git clone <repo> /opt/openadult
cd /opt/openadult

# 2. 配置环境变量
# 参考 deploy/docs/env-template.md
cp deploy/docs/env-template.md .env
vim .env  # 填写实际值

# 3. 一键部署
sudo bash deploy/scripts/deploy.sh
```

### 手动部署 (分步)

```bash
# 构建应用
pnpm install && pnpm build

# 启动 Docker 服务
cd deploy/docker
docker compose --env-file ../../.env up -d

# 验证
curl http://localhost:3000/health
docker compose ps
```

## 架构说明

### HLS 模式切换

通过 `HLS_MODE` 环境变量控制:

- `pseudo` (默认/开发): 单 MP4 文件 + byte-range 模拟 HLS
- `real` (生产): FFmpeg 预转码的真实 .ts 片段, 从 CDN 提供

### 广告拼接流程

1. 用户请求 `master.m3u8` → OpenResty 拦截
2. OpenResty 调用广告决策服务 → 获取广告配置
3. Lua 脚本动态拼接广告片段到 m3u8
4. 返回带广告的播放列表给 hls.js
5. hls.js 按顺序请求 .ts 片段 (广告+正片)

### 反封锁机制

1. **域名轮换**: 60秒检测一次, 封锁后自动切换
2. **JS Challenge**: 阻止爬虫和自动化扫描
3. **CDN 隐藏**: 源站 IP 永不暴露
4. **Telegram 通知**: 新域名自动推送给用户

## 监控

- Grafana: `http://server-ip:3100` (默认密码: admin)
- Prometheus: `http://server-ip:9090`

## 常见问题

### Q: 转码失败?
检查 FFmpeg 日志: `docker compose logs transcoder`

### Q: 广告不显示?
1. 确认 `HLS_MODE=real`
2. 确认广告素材已转码并上传到 S3
3. 检查广告管理面板中的配置

### Q: 域名被封后无法访问?
1. 检查 Telegram 频道获取新域名
2. 手动触发: `docker compose exec domain-rotator python -c "from domain_rotator import *; DomainRotator(CONFIG).rotate_domain('blocked.com')"`
