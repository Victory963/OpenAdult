/**
 * ============================================================================
 * server/_core/index.ts — Node 服务进程唯一入口（Express + HTTP Server 装配）
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 进程启动层**。
 * 这是 `pnpm build` 时 esbuild 的打包入口（产物 `dist/index.js`），也是
 * `pnpm dev` 时 tsx 直接执行的文件。所有 HTTP 入口（tRPC / OAuth / HLS /
 * 存储代理 / 静态资源）都在这里按**注册顺序**挂到同一个 Express app 上。
 *
 * ## 主要导出
 * 本文件**无导出**（side-effect only）。末尾直接调用 `startServer()` 启动进程。
 *
 * ## 中间件 / 路由挂载顺序（顺序即优先级，改动需谨慎）
 * ```
 *  1. express.json / urlencoded  —— body parser（50mb，见下方说明）
 *  2. registerStorageProxy       —— /manus-storage/*  S3 对象代理
 *  3. registerVideoStream        —— 视频直链流式代理（Range 请求）
 *  4. registerFastUpload         —— 二进制快传，绕过 tRPC 以避免 base64 膨胀
 *  5. /api/hls                   —— HLS manifest(m3u8) + segment(ts) 分发
 *  6. registerOAuthRoutes        —— /api/oauth/callback
 *  7. /health                    —— Docker healthcheck 探针
 *  8. /api/trpc                  —— 全部业务 API（appRouter）
 *  9. Vite(dev) / static(prod)   —— 兜底 SPA，必须放最后，因为它带 "*" 通配
 * ```
 * 第 9 步的 `app.use("*")` 会吞掉一切未匹配路径，**任何新增的 REST 路由都必须
 * 注册在它之前**，否则会被 SPA 的 index.html 兜底覆盖。
 *
 * ## 上下游依赖
 * - 上游：Docker `CMD node dist/index.js` / `pnpm dev`；外层由 Nginx 反代。
 * - 下游：`../routers`（tRPC appRouter）、`./context`（每请求鉴权上下文）、
 *         `./oauth`、`./storageProxy`、`./videoStream`、`./fastUpload`、
 *         `./hlsRoutes`、`./vite`。
 *
 * ## 关键设计决策 / 坑
 * - **`import "dotenv/config"` 必须是第一行**：`./env` 在模块加载期就读取
 *   `process.env`，若 dotenv 晚于它执行，所有环境变量都会是空字符串。
 * - **端口自动避让**：见 `findAvailablePort`。生产环境下这会导致进程监听的端口
 *   与 `PORT` 不一致，而 Docker 的端口映射是静态的 —— 若 3000 被占用，
 *   容器健康检查会失败。该行为主要是为本地开发多实例并存服务的。
 */
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { registerVideoStream } from "./videoStream";
import { registerFastUpload } from "./fastUpload";
import hlsRouter from "./hlsRoutes";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

/**
 * 探测指定端口当前是否可绑定。
 *
 * 实现方式是「真的开一个 TCP server 再立刻关掉」——这是 Node 下唯一可靠的
 * 探测手段（不存在同步的 "isPortFree" API）。任何 error（EADDRINUSE、
 * EACCES 等）一律视为不可用，不区分原因。
 *
 * 副作用：短暂占用该端口（listen → close），存在极小的 TOCTOU 竞态窗口
 * ——探测通过后到 `server.listen()` 真正绑定之间，端口仍可能被别的进程抢走。
 *
 * @param port 待探测端口
 * @returns 可绑定返回 true，否则 false（不抛错）
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

/**
 * 从 `startPort` 起向上顺序扫描，返回第一个可用端口。
 *
 * 扫描窗口固定为 20 个端口（startPort ~ startPort+19）——这个数字没有协议含义，
 * 纯粹是「本地开发同时跑的实例数不会超过 20」的经验上限，用来防止无限循环。
 * 注意是串行 await，最坏情况会有 20 次 listen/close 往返，但每次都是本机
 * loopback 操作，耗时可忽略。
 *
 * @param startPort 起始端口，默认 3000
 * @returns 首个可用端口号
 * @throws 窗口内 20 个端口全被占用时抛 Error
 */
async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * 装配并启动整个 HTTP 服务。
 *
 * 这里显式创建了独立的 `http.Server`（而非直接 `app.listen()`），因为开发模式下
 * Vite 的 HMR WebSocket 需要复用同一个 server 实例（见 `setupVite` 的
 * `hmr: { server }`）——`app.listen()` 拿不到这个句柄。
 *
 * 副作用：绑定 TCP 端口、启动 Vite dev server（开发模式）、注册全部路由。
 * 进程生命周期内只应调用一次。
 *
 * @throws 无可用端口时由 `findAvailablePort` 抛出（被文件末尾的 catch 兜住）
 */
async function startServer() {
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  // 50mb：为 base64 内联的图片/封面上传预留（base64 会让体积膨胀约 1.33 倍）。
  // 真正的大文件走 registerFastUpload 的二进制通道，不经过这两个 parser。
  // 注意此上限对所有路由生效，包括 tRPC —— 调大会同步放大内存放大攻击面。
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Storage proxy for serving uploaded files
  // S3 对象代理：把 /manus-storage/* 转成 presigned URL 或直接回源，
  // 使前端无需感知 bucket 名与凭证。
  registerStorageProxy(app);
  // 视频直链流式代理：负责处理 Range 请求（拖动进度条）与断点续传。
  registerVideoStream(app);
  // Fast binary upload endpoint (bypasses tRPC for speed)
  // 绕过 tRPC 的原因：tRPC + superjson 只能传 JSON，大文件必须 base64 编码，
  // 体积 +33% 且需全量驻留内存；这里直接收原始 octet-stream 流式落盘/转存 S3。
  registerFastUpload(app);
  // HLS streaming routes (m3u8 manifest + segment delivery)
  // 挂在 tRPC 之前：播放器请求 .m3u8/.ts 的频率极高，走独立 Express router
  // 可避开 tRPC 的上下文构建（含一次 DB 查询用户）开销。
  app.use("/api/hls", hlsRouter);
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // Health check endpoint (for Docker healthcheck)
  // 必须保持极轻量（不查库、不打外部依赖）：docker-compose 的 healthcheck
  // 按固定间隔轮询，任何阻塞都会被判定为容器不健康并触发重启。
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // tRPC API
  // 全部业务 API 的统一入口。createContext 每个请求执行一次，负责解析
  // session cookie 得到 ctx.user（失败则为 null，由各 procedure 的权限中间件裁决）。
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  // 两个分支都会注册 app.use("*") 兜底，因此必须放在所有 API 路由之后。
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  // 端口发生避让时只是打印日志、不报错。生产环境下这意味着实际监听端口
  // 与容器端口映射/Nginx upstream 配置不再一致，属于需要人工关注的静默降级。
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

// 顶层启动。注意这里只是打印错误而未 process.exit(1)：
// 启动失败时进程仍会存活（事件循环可能已被 Vite 等句柄持有），
// 容器编排层无法通过退出码感知失败，只能靠 /health 探针。
startServer().catch(console.error);
