# CLAUDE.md — OpenAdult 项目指南

> 本文件为 Claude Code (claude-code CLI) 提供项目上下文。
> 当你在此仓库中工作时，请遵循以下约定和架构说明。

---

## 项目概述

**OpenAdult** 是一个全栈成人视频平台，提供 AI 驱动的推荐、女优相似度检索、HLS 流媒体播放、广告拼接 (SSAI)、域名轮换反封锁等功能。

| 属性 | 值 |
|------|-----|
| 语言 | TypeScript (全栈) |
| 前端 | React 19 + Tailwind CSS 4 + shadcn/ui |
| 后端 | Express 4 + tRPC 11 |
| 数据库 | MySQL/TiDB (Drizzle ORM) |
| 存储 | S3 兼容 (Backblaze B2) |
| 认证 | Manus OAuth + JWT Cookie |
| AI | LLM 聊天推荐 + 图像分析 |
| 部署 | Docker Compose + Nginx + OpenResty |
| 代码行数 | ~27,000 行 TypeScript |

---

## 快速命令

```bash
# 安装依赖
pnpm install

# 开发模式 (带热重载)
pnpm dev

# 构建生产版本
pnpm build

# 启动生产服务器
pnpm start

# 类型检查
pnpm check

# 运行测试
pnpm test

# 格式化代码
pnpm format

# 数据库迁移生成
pnpm db:push
```

---

## 代码目录树

```
openadult-deploy/
├── CLAUDE.md                          # 本文件 - Claude Code 项目指南
├── package.json                       # 项目依赖和脚本
├── tsconfig.json                      # TypeScript 配置
├── vite.config.ts                     # Vite 构建配置 (前端)
├── vitest.config.ts                   # Vitest 测试配置
├── drizzle.config.ts                  # Drizzle ORM 配置
├── components.json                    # shadcn/ui 组件配置
├── .dockerignore                      # Docker 构建忽略
├── patches/                           # pnpm 补丁
│   └── wouter@3.7.1.patch
│
├── client/                            # ===== 前端 (React SPA) =====
│   ├── index.html                     # HTML 入口
│   ├── public/                        # 静态文件 (仅小配置文件)
│   └── src/
│       ├── main.tsx                   # React 入口 (tRPC Provider 初始化)
│       ├── App.tsx                    # 路由定义 (wouter)
│       ├── index.css                  # 全局样式 + Tailwind 主题
│       ├── const.ts                   # 前端常量 (OAuth URL 等)
│       ├── pages/                     # 页面组件
│       │   ├── Home.tsx               # 首页 (搜索框 + 分类)
│       │   ├── ChatPage.tsx           # AI 聊天推荐页
│       │   ├── VideosPage.tsx         # 视频列表页 (V1)
│       │   ├── VideosPageV2.tsx       # 视频列表页 (V2, 分类筛选)
│       │   ├── VideoDetailPage.tsx    # 视频详情 + HLS 播放器
│       │   ├── FaceSearchPage.tsx     # 女优相似度检索 (名称/图像)
│       │   ├── SearchResultsPage.tsx  # 综合搜索结果
│       │   ├── ActressManagementPage.tsx  # 管理面板入口
│       │   ├── AdminLoginPage.tsx     # 管理员登录
│       │   ├── Dashboard.tsx          # 用户仪表盘
│       │   ├── ComponentShowcase.tsx  # 组件展示
│       │   └── NotFound.tsx           # 404 页面
│       ├── components/                # 可复用组件
│       │   ├── AIChatBox.tsx          # AI 聊天界面
│       │   ├── ActressManagementUI.tsx # 女优管理 CRUD
│       │   ├── AdManagementUI.tsx     # 广告管理
│       │   ├── VideoManagementUI.tsx  # 视频管理
│       │   ├── VideoPlayer.tsx        # HLS 视频播放器
│       │   ├── VideoCard.tsx          # 视频卡片
│       │   ├── VideoUploadForm.tsx    # 视频上传表单
│       │   ├── VideoActressLinker.tsx  # 视频-女优关联
│       │   ├── DashboardLayout.tsx    # 管理面板布局
│       │   ├── FileUploadBox.tsx      # 文件上传组件
│       │   ├── LanguageSwitcher.tsx   # 多语言切换
│       │   ├── ErrorBoundary.tsx      # 错误边界
│       │   └── ui/                    # shadcn/ui 基础组件 (40+)
│       ├── contexts/                  # React Context
│       │   ├── LanguageContext.tsx    # 多语言 (ja/zh/en)
│       │   └── ThemeContext.tsx       # 暗色/亮色主题
│       ├── hooks/                     # 自定义 Hooks
│       │   ├── useComposition.ts      # 输入法组合状态
│       │   ├── useMobile.tsx          # 移动端检测
│       │   └── usePersistFn.ts        # 持久化回调
│       ├── lib/                       # 工具库
│       │   ├── trpc.ts               # tRPC 客户端绑定
│       │   ├── utils.ts              # cn() 等工具函数
│       │   └── videoUrl.ts           # 视频 URL 处理
│       └── locales/
│           └── translations.ts        # 多语言翻译文件
│
├── server/                            # ===== 后端 (Express + tRPC) =====
│   ├── _core/                         # 框架核心 (谨慎修改)
│   │   ├── index.ts                  # 服务器入口 + Express 配置
│   │   ├── env.ts                    # 环境变量定义
│   │   ├── trpc.ts                   # tRPC 初始化 + 权限中间件
│   │   ├── context.ts                # tRPC 请求上下文
│   │   ├── sdk.ts                    # Manus OAuth SDK
│   │   ├── oauth.ts                  # OAuth 路由注册
│   │   ├── cookies.ts                # Cookie 配置
│   │   ├── llm.ts                    # LLM 调用封装 (invokeLLM)
│   │   ├── faceRecognition.ts        # LLM 驱动的人脸特征分析
│   │   ├── imageGeneration.ts        # 图像生成
│   │   ├── voiceTranscription.ts     # 语音转文字
│   │   ├── storageProxy.ts           # S3 存储代理
│   │   ├── videoStream.ts            # 视频流代理
│   │   ├── videoThumbnail.ts         # 视频缩略图
│   │   ├── hlsRoutes.ts             # HLS 流路由 (m3u8 + ts)
│   │   ├── fastUpload.ts            # 快速二进制上传
│   │   ├── heartbeat.ts             # 定时任务心跳
│   │   ├── notification.ts          # 通知服务
│   │   ├── dataApi.ts               # 外部数据 API
│   │   ├── map.ts                    # Google Maps 代理
│   │   ├── systemRouter.ts          # 系统路由
│   │   └── vite.ts                   # Vite 开发/静态文件服务
│   ├── routers.ts                     # 路由注册总入口
│   ├── routers/                       # 功能路由模块
│   │   ├── videos.ts                 # 视频 CRUD (V1)
│   │   ├── videos-v2.ts             # 视频 CRUD (V2, 增强版)
│   │   ├── video-upload.ts          # 视频上传 (V1)
│   │   ├── video-upload-v2.ts       # 视频分片上传 (V2)
│   │   ├── actressManagement.ts     # 女优管理 (V1)
│   │   ├── actress-management-v2.ts # 女优管理 (V2, 增强版)
│   │   ├── faceSearch.ts            # 女优相似度检索
│   │   ├── admin-auth.ts            # 管理员认证 (独立密码)
│   │   ├── hls-stream.ts            # HLS 流管理
│   │   └── ad-management.ts         # 广告管理
│   ├── db.ts                          # 数据库查询助手 (所有 DB 操作)
│   ├── storage.ts                     # S3 存储操作 (storagePut/Get)
│   ├── search.ts                      # 搜索路由 (文本/图像)
│   ├── file-upload.ts                 # 文件上传路由
│   ├── llm-prompts.ts                # LLM 提示词模板
│   └── *.test.ts                      # 测试文件 (Vitest)
│
├── drizzle/                           # ===== 数据库 =====
│   ├── schema.ts                     # 表结构定义 (15 张表)
│   ├── relations.ts                  # 表关系定义
│   ├── 0000_*.sql ~ 0003_*.sql       # 迁移 SQL 文件
│   └── meta/                         # Drizzle 元数据
│
├── shared/                            # ===== 前后端共享 =====
│   ├── const.ts                      # 共享常量
│   ├── types.ts                      # 共享类型导出
│   └── _core/errors.ts              # 错误类型
│
├── deploy/                            # ===== 部署配置 =====
│   ├── docker/
│   │   ├── Dockerfile.app            # 应用容器 (多阶段构建)
│   │   ├── Dockerfile.transcoder     # FFmpeg 转码容器
│   │   ├── Dockerfile.rotator        # 域名轮换容器
│   │   └── docker-compose.yml        # 服务编排 (8 个服务)
│   ├── nginx/
│   │   ├── openadult-main.conf       # 主站 Nginx 配置
│   │   ├── cloudflare-ips.conf       # Cloudflare IP 白名单
│   │   └── js-challenge.conf         # JS 挑战防护
│   ├── openresty/
│   │   ├── openresty-cdn.conf        # CDN 配置
│   │   └── lua/                      # Lua 广告拼接脚本
│   ├── ffmpeg/                       # 转码脚本
│   ├── anti-block/                   # 反封锁系统
│   │   ├── domain_rotator.py         # 域名轮换 (Python)
│   │   └── challenge.html            # JS 挑战页
│   ├── monitoring/                   # Prometheus 配置
│   ├── scripts/
│   │   └── deploy.sh                # 一键部署脚本
│   └── docs/
│       ├── DEPLOY_TUTORIAL_CN.md     # 中文部署教程
│       └── env-template.md           # 环境变量模板
│
└── references/                        # 参考文档
    └── periodic-updates.md           # 定时任务说明
```

---

## 架构概览

### 请求流程

```
浏览器 → Cloudflare CDN → Nginx (SSL终止)
  ├── /api/trpc/* → Express → tRPC Router → DB/S3/LLM
  ├── /api/hls/*  → Express → HLS Routes → S3 (视频流)
  ├── /api/oauth/* → Express → Manus OAuth
  ├── /manus-storage/* → Express → S3 Presigned URL
  ├── /health → Express → { status: "ok" }
  └── /* → Nginx 静态文件 (dist/public/)
```

### 认证模型

```
publicProcedure   → 无需登录 (视频列表、搜索)
protectedProcedure → 需要登录 (收藏、聊天、推荐)
adminProcedure    → 需要 admin 角色 (管理面板)
admin-auth        → 独立密码认证 (管理面板登录)
```

### 数据库表 (15 张)

| 表名 | 用途 |
|------|------|
| users | 用户账号 (OAuth) |
| videos | 视频元数据 |
| actresses | 女优信息 |
| video_actresses | 视频-女优关联 |
| chat_messages | AI 聊天历史 |
| search_history | 搜索历史 |
| favorites | 用户收藏 |
| resume_playback | 续播位置 |
| user_preferences | 用户偏好 |
| recommendations | AI 推荐 |
| user_uploads | 用户上传 |
| actress_face_embeddings | 人脸特征向量 |
| face_search_history | 人脸搜索历史 |
| video_upload_sessions | 分片上传会话 |
| video_upload_chunks | 分片上传块 |
| ads | 广告素材 |
| ad_placements | 广告投放位置 |
| ad_impressions | 广告展示追踪 |

### Docker 服务 (生产环境)

| 服务 | 端口 | 用途 |
|------|------|------|
| app | 3000 | Node.js API + 前端 |
| nginx | 80/443 | 反向代理 + SSL |
| openresty | 8080 | CDN + 广告拼接 |
| transcoder | - | FFmpeg HLS 转码 |
| domain-rotator | - | 域名轮换 |
| redis | 6379 | 缓存 |
| prometheus | 9090 | 指标收集 |
| grafana | 3100 | 监控面板 |

---

## 开发规范

### 添加新功能的标准流程

1. **数据库** — 修改 `drizzle/schema.ts`，运行 `pnpm drizzle-kit generate` 生成迁移 SQL
2. **查询助手** — 在 `server/db.ts` 添加数据库操作函数
3. **路由** — 在 `server/routers/` 创建新路由文件，在 `server/routers.ts` 注册
4. **前端** — 在 `client/src/pages/` 创建页面，使用 `trpc.*.useQuery/useMutation`
5. **测试** — 在 `server/*.test.ts` 编写 Vitest 测试
6. **路由注册** — 在 `client/src/App.tsx` 添加路由

### TypeScript 约定

- 使用 ESM 模块 (`"type": "module"`)
- 路径别名: `@/` → `client/src/`, `@shared/` → `shared/`
- 严格模式 (`"strict": true`)
- 模块解析: `bundler`
- 不生成输出文件 (`"noEmit": true`)

### tRPC 约定

- 所有 API 通过 tRPC 定义，不使用原始 REST 路由 (除了 OAuth、HLS、健康检查)
- 使用 `superjson` 作为序列化器 (Date 等类型自动处理)
- 输入验证使用 `zod`
- 前端使用 `trpc.*.useQuery()` / `trpc.*.useMutation()`

### 前端约定

- 使用 shadcn/ui 组件 (从 `@/components/ui/*` 导入)
- 使用 Tailwind CSS 4 进行样式设计
- 使用 wouter 进行路由 (非 react-router)
- 使用 `useAuth()` 获取用户状态
- 暗色主题为默认主题
- 多语言支持: 日语 (ja)、中文 (zh)、英语 (en)

### 后端约定

- `server/_core/` 目录为框架核心，**不要随意修改**
- 数据库操作集中在 `server/db.ts`
- LLM 调用使用 `invokeLLM()` (从 `server/_core/llm.ts` 导入)
- 文件存储使用 `storagePut()` / `storageGet()` (从 `server/storage.ts` 导入)
- 环境变量通过 `ENV` 对象访问 (从 `server/_core/env.ts` 导入)

### 测试约定

- 测试框架: Vitest
- 测试文件位置: `server/*.test.ts`
- 运行: `pnpm test`
- 仅测试服务端逻辑 (environment: "node")

---

## 环境变量

### 必需变量

| 变量 | 用途 |
|------|------|
| DATABASE_URL | MySQL 连接字符串 |
| JWT_SECRET | Cookie 签名密钥 |
| VITE_APP_ID | Manus OAuth App ID |
| OAUTH_SERVER_URL | OAuth 服务器 URL |
| VITE_OAUTH_PORTAL_URL | OAuth 登录页 URL |
| OWNER_OPEN_ID | 所有者 OpenID |
| BUILT_IN_FORGE_API_URL | Forge API URL |
| BUILT_IN_FORGE_API_KEY | Forge API Key |
| HERETIC_LLM_MODEL | LLM 模型名称 |

### 可选变量

| 变量 | 用途 |
|------|------|
| S3_BUCKET | S3 存储桶名 |
| S3_ENDPOINT | S3 端点 URL |
| AWS_ACCESS_KEY_ID | S3 访问密钥 |
| AWS_SECRET_ACCESS_KEY | S3 密钥 |
| CDN_BASE_URL | CDN 基础 URL |
| HLS_MODE | HLS 模式 (pseudo/real) |
| ADMIN_API_KEY | 管理员 API 密钥 |
| CF_API_TOKEN | Cloudflare API Token |
| CF_ZONE_ID | Cloudflare Zone ID |
| TG_BOT_TOKEN | Telegram Bot Token |
| DOMAIN_POOL | 域名池 JSON 数组 |

---

## 构建与部署

### 构建流程

```bash
pnpm build
# 等同于:
# 1. vite build → 输出到 dist/public/ (前端静态文件)
# 2. esbuild server/_core/index.ts → 输出到 dist/index.js (后端)
```

### 生产启动

```bash
NODE_ENV=production node dist/index.js
# 服务器监听 PORT 环境变量 (默认 3000)
# 静态文件从 dist/public/ 提供
```

### Docker 部署

```bash
cd deploy/docker
docker compose --env-file ../../.env up -d
```

---

## 关键设计决策

1. **tRPC-first**: 所有业务逻辑通过 tRPC 过程暴露，类型从服务端流向客户端
2. **LLM 驱动的人脸识别**: 不使用 face-api.js (Node.js 不支持 DOM)，改用 LLM 图像分析提取面部特征描述进行匹配
3. **双版本路由**: videos/videos-v2, actressManagement/actress-management-v2 — V2 为增强版，V1 保留向后兼容
4. **管理员双认证**: OAuth 用户认证 + 独立管理员密码认证 (admin-auth)
5. **HLS 流媒体**: 支持伪 HLS (pseudo) 和真实 HLS (real) 两种模式
6. **域名轮换**: Python 脚本 + Cloudflare API 自动轮换被封域名
7. **SSAI 广告**: OpenResty Lua 脚本在 CDN 层拼接广告片段

---

## 常见任务指南

### 添加新的 tRPC 路由

```typescript
// 1. 创建 server/routers/my-feature.ts
import { publicProcedure, protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";

export const myFeatureRouter = router({
  list: publicProcedure.query(async () => { /* ... */ }),
  create: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input, ctx }) => { /* ... */ }),
});

// 2. 在 server/routers.ts 注册
import { myFeatureRouter } from "./routers/my-feature";
export const appRouter = router({
  // ...existing routers
  myFeature: myFeatureRouter,
});

// 3. 前端调用
const { data } = trpc.myFeature.list.useQuery();
const mutation = trpc.myFeature.create.useMutation();
```

### 添加新的数据库表

```typescript
// 1. 在 drizzle/schema.ts 添加表定义
export const myTable = mysqlTable("my_table", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

// 2. 生成迁移
// pnpm drizzle-kit generate

// 3. 应用迁移 SQL 到数据库
```

### 调用 LLM

```typescript
import { invokeLLM } from "../_core/llm";

const response = await invokeLLM({
  messages: [
    { role: "system", content: "你是一个助手" },
    { role: "user", content: "分析这段文本" },
  ],
});
const result = response.choices[0]?.message?.content;
```

### 上传文件到 S3

```typescript
import { storagePut } from "../storage";

const { key, url } = await storagePut(
  `uploads/${userId}/${filename}`,
  fileBuffer,
  "image/png"
);
// url 可直接在前端使用: <img src={url} />
```

---

## 注意事项

1. **不要修改 `server/_core/`** — 这是框架基础设施，除非你确切知道在做什么
2. **不要在 `client/public/` 放大文件** — 会导致部署超时，使用 S3 存储
3. **不要硬编码端口号** — 使用 `process.env.PORT`
4. **不要使用 `source .env`** — .env 中可能有 JSON 值，使用脚本中的安全加载方式
5. **数据库操作集中在 db.ts** — 不要在路由文件中直接写 SQL
6. **前端不要直接调用 fetch/axios** — 使用 tRPC hooks
7. **测试文件排除在 tsconfig 编译之外** — 但 vitest 会单独处理它们
