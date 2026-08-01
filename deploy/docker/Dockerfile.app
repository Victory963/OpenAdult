# ============================================================
# OpenAdult API Server Dockerfile
# 多阶段构建: 依赖安装 -> ビルド -> 本番イメージ
# ============================================================

# Stage 1: 依赖安装
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Stage 2: ビルド
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable pnpm && pnpm build

# Stage 3: 本番イメージ
FROM node:22-alpine AS runner
WORKDIR /app

# セキュリティ: non-root ユーザー
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 openadult

# 必要なファイルのみコピー
# dist/ 包含: dist/index.js (服务器), dist/public/ (前端静态文件)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./
# drizzle-kit 在 node_modules 中（builder 阶段安装了全部依赖）。
# 迁移由 compose 的一次性 `migrate` 服务执行：pnpm exec drizzle-kit migrate

# ログディレクトリ
RUN mkdir -p /var/log/openadult && chown openadult:nodejs /var/log/openadult

USER openadult

# ヘルスチェック
# 健康检查 (wget 在 alpine 中预装)
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

EXPOSE 3000

CMD ["node", "dist/index.js"]
