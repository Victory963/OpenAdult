/**
 * ============================================================================
 * server/_core/vite.ts — 前端资源服务（开发走 Vite 中间件，生产走静态目录）
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 静态资源 / SPA 兜底层**。
 * 由 `server/_core/index.ts` 在**所有 API 路由注册完毕之后**按 `NODE_ENV` 二选一调用。
 *
 * ## 主要导出
 * - `setupVite(app, server)` —— 开发模式：以 middleware 模式内嵌 Vite dev server，
 *   提供模块转换、HMR 与 index.html 实时注入。
 * - `serveStatic(app)`       —— 生产模式：直接吐 `dist/public/` 下的构建产物。
 *
 * ## 上下游依赖
 * - 上游：`server/_core/index.ts`。
 * - 下游：`vite`、根目录 `vite.config.ts`（复用同一份别名/插件配置）。
 *
 * ## 关键设计决策 / 坑
 * - **两个函数都注册 `app.use("*")` 通配兜底**，把未匹配的路径统一返回 index.html
 *   （SPA 客户端路由所需）。因此**它们必须最后注册**，否则会吞掉所有 API 路由。
 * - 同样因为这个通配兜底，**不存在的 API 路径不会返回 404 JSON，而是返回 200 + HTML** ——
 *   前端 fetch 拿到 HTML 解析失败时，实际原因往往是路径写错了。
 * - 开发模式与 Express 共用同一个 `http.Server` 实例，HMR 的 WebSocket 才能与
 *   HTTP 复用端口（见 `hmr: { server }`）。
 */
import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

/**
 * 开发模式：把 Vite dev server 以中间件形式挂到 Express 上。
 *
 * 相比"前端 5173 + 后端 3000 两个进程 + 代理"的方案，单进程同端口可以彻底
 * 规避跨域与 cookie SameSite 问题（本项目 session cookie 是 `sameSite: "none"`，
 * 分端口调试会非常痛苦）。
 *
 * @param app    Express 应用
 * @param server 与 Express 共用的 http.Server，供 HMR WebSocket 复用端口
 *
 * 副作用：启动 Vite dev server（文件监听、依赖预构建），注册中间件与 `*` 兜底路由。
 */
export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    // middlewareMode：不自己监听端口，只暴露 middleware 交给宿主 Express。
    middlewareMode: true,
    // 复用宿主的 http.Server，使 HMR WebSocket 与 HTTP 同端口。
    hmr: { server },
    // 放行任意 Host 头。开发时常通过内网 IP / ngrok / 自定义域名访问，
    // 逐个白名单太麻烦。仅限开发环境，生产不走这条分支。
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    // configFile: false —— 禁止 Vite 再去磁盘上找 vite.config.ts，
    // 因为上面已经用扩展运算符把配置对象整个内联进来了，重复加载会导致插件被实例化两次。
    configFile: false,
    server: serverOptions,
    // appType: "custom" —— 关闭 Vite 内建的 SPA history fallback，
    // 改由下面的 app.use("*") 自行处理 HTML 返回（这样才能插入 nanoid 缓存戳）。
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      // 相对本文件定位到仓库根下的 client/index.html。
      // 注意 import.meta.dirname 在开发模式指向 server/_core/，故上跳两级到仓库根。
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      // 每次请求都重读磁盘（不缓存），这样改 index.html 无需重启服务。
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      // 给入口模块加随机 query（nanoid）强制浏览器重新拉取 main.tsx。
      // 目的是绕过浏览器/Vite 对入口模块的缓存，避免改了入口却不生效的问题。
      // 副作用：每次刷新都是全新模块图，会牺牲部分 HMR 状态保持能力。
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      // 交给 Vite 注入 HMR client、@react-refresh 预导入以及插件的 HTML 变换。
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      // 把 Vite 转换后的堆栈映射回源码位置，否则报错行号指向编译产物，无法排查。
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

/**
 * 生产模式：直接提供 `pnpm build` 产出的前端静态文件。
 *
 * @param app Express 应用
 *
 * 副作用：注册 `express.static` 与 `*` 兜底路由。
 */
export function serveStatic(app: Express) {
  // 产物路径随运行形态而变：
  // - 打包后（生产）：本文件已被 esbuild 打成 dist/index.js，
  //   import.meta.dirname === dist/，故静态目录是 dist/public；
  // - 未打包（以 tsx 直跑源码但 NODE_ENV=development）：本文件在 server/_core/，
  //   需上跳两级到仓库根再进 dist/public。
  // 判断条件写的是 NODE_ENV 而非"是否已打包"，属于用环境变量间接推断运行形态。
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  // 只打印错误、不抛错也不退出：服务照常启动，但所有页面请求都会失败
  // （sendFile 找不到 index.html → 500）。忘记先构建前端时就是这个症状。
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  // SPA history fallback：把所有未命中静态文件的路径交还给前端路由（wouter）处理。
  // 代价是拼错的 API 路径也会返回 200 + HTML，而不是 404。
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
