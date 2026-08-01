/**
 * ============================================================================
 * client/src/main.tsx — 前端应用的唯一入口 (UI 层 / 应用启动引导)
 * ============================================================================
 *
 * 架构角色：
 *   Vite 通过 client/index.html 中的 <script type="module" src="/src/main.tsx">
 *   加载本文件。它是整个 React SPA 的引导 (bootstrap) 点，负责在渲染 <App /> 之前
 *   把两套"全局基础设施"装配好：
 *     1. TanStack Query 的 QueryClient —— 所有服务端状态的缓存/重试/失效中心；
 *     2. tRPC React 客户端 (trpcClient) —— 类型安全的 RPC 传输层，指向后端 /api/trpc。
 *
 * 主要导出物：
 *   无具名导出。本文件是副作用模块 (side-effect module)：执行即渲染整棵 React 树。
 *
 * 上下游依赖：
 *   ← 被 client/index.html 直接引用（唯一调用方）
 *   → @/lib/trpc          : createTRPCReact<AppRouter>() 产出的 trpc 对象（含 Provider）
 *   → ./App               : 路由与全局 Provider 组合
 *   → ./const#getLoginUrl : 运行时拼装 Manus OAuth 登录 URL
 *   → @shared/const       : 与后端共享的错误文案常量，用于识别"未登录"错误
 *   → ./index.css         : Tailwind 4 主题与全局样式（必须在此导入才会被 Vite 处理）
 *
 * 关键设计决策：
 *   - **全局 401 拦截**：项目没有为每个 useQuery/useMutation 单独处理鉴权失败，
 *     而是在 QueryCache / MutationCache 上挂一个订阅者统一拦截，避免样板代码。
 *   - **靠错误文案而非错误码判断未登录**：后端 protectedProcedure 抛出的消息是
 *     @shared/const 中的 UNAUTHED_ERR_MSG，前后端共享同一常量以保证一致性。
 *   - **credentials: "include"**：认证态存放在 HttpOnly Cookie 中（见 server/_core/cookies.ts），
 *     必须显式携带 Cookie，否则所有 protectedProcedure 都会 401。
 */

import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

/**
 * 全局唯一的 TanStack Query 客户端。
 * 使用库默认配置（staleTime=0、失败重试 3 次等）；单点覆盖的策略写在各个
 * useQuery 调用处（例如 useAuth 中的 auth.me 显式 retry:false）。
 */
const queryClient = new QueryClient();

/**
 * 统一的"未登录 → 跳转 OAuth 登录页"处理器。
 *
 * @param error 来自 query/mutation 缓存的错误对象，类型未知，需逐层收窄。
 * @returns void；副作用是可能整页跳转 (window.location.href)。
 *
 * 逐条守卫的含义：
 *   1. 非 TRPCClientError（如网络错误、渲染错误）不属于鉴权范畴，直接忽略；
 *   2. window 不存在说明处于 SSR/测试环境，无法跳转；
 *   3. 只有消息恰好等于 UNAUTHED_ERR_MSG 才认定是"缺少登录态"，
 *      NOT_ADMIN_ERR_MSG（权限不足）不会触发跳转——那种情况应由页面自行提示。
 */
const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

// 订阅 QueryCache：任何 useQuery 失败都会走到这里。
// 这里必须同时判断 event.type === "updated" 且 action.type === "error"，
// 因为缓存会为 added/removed/observerAdded 等生命周期发出大量事件，
// 只有 "updated + error" 这一组合代表"某次请求刚刚失败"。
queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

// 同上，但针对 mutation（写操作）。query 与 mutation 是两套独立缓存，
// 必须分别订阅，否则 useMutation 的 401 不会触发登录跳转。
queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

/**
 * tRPC 客户端实例。
 *
 * 链路配置说明：
 *   - httpBatchLink：把同一 tick 内发起的多个 procedure 调用合并成一个 HTTP 请求，
 *     显著减少首屏并发数（首页会同时拉 auth.me / videos.list / 分类等）。
 *   - url "/api/trpc"：相对路径，因此开发环境走 Vite 代理、生产环境走 Nginx 同源转发，
 *     不需要为不同环境切换域名，也天然规避跨域与域名轮换带来的问题。
 *   - transformer superjson：与后端 server/_core/trpc.ts 保持一致，
 *     使 Date / Map / undefined 等类型能无损穿过 JSON 边界。
 *   - 自定义 fetch：仅为注入 credentials:"include"，让浏览器带上会话 Cookie。
 */
const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

// 挂载 React 19 根节点。
// Provider 顺序不可颠倒：trpc.Provider 内部依赖 QueryClientProvider 之外还需要自身
// 的 client，而 trpc 的 hooks 最终由 QueryClientProvider 提供缓存，因此两者都必须
// 包在 <App /> 之外；"#root" 由 client/index.html 提供，用 ! 断言其必然存在。
createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
