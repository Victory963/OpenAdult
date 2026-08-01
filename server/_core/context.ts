/**
 * ============================================================================
 * server/_core/context.ts — tRPC 每请求上下文（request context）构建
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— API 基础设施层**。
 * 由 `server/_core/index.ts` 传给 `createExpressMiddleware`，**每个 tRPC 请求
 * 调用一次**，产出的对象即所有 resolver 中的 `ctx`。
 *
 * ## 主要导出
 * - `TrpcContext` —— 上下文类型。被 `./trpc.ts` 用作 `initTRPC.context<...>()`
 *   的泛型参数，因而决定了全后端 `ctx` 的形状。
 * - `createContext(opts)` —— 上下文工厂。
 *
 * ## 上下游依赖
 * - 上游：`server/_core/index.ts`（注册）、`server/_core/trpc.ts`（类型绑定）。
 * - 下游：`./sdk`（`authenticateRequest` 解析 session cookie → 查库 → User）。
 *
 * ## 关键设计决策 / 坑
 * - **鉴权失败不抛错**：这是本文件最核心的约定。匿名访问是常态（视频列表、搜索），
 *   所以这里把异常吞掉并置 `user = null`，把"要不要拦"的决定权交给
 *   `protectedProcedure` / `adminProcedure` 中间件。
 * - **性能代价**：`authenticateRequest` 内部会做 JWT 验签 + 至少一次
 *   `getUserByOpenId` 查询 + 一次 `upsertUser` 写库（更新 lastSignedIn）。
 *   也就是说**每个 tRPC 请求（哪怕是 public 的）都会产生一次数据库写**。
 *   高 QPS 的读接口应考虑绕开 tRPC（HLS 路由正是这么做的）。
 * - `req` / `res` 被透传进 ctx，供需要读写 cookie 的 procedure 使用
 *   （如 `auth.logout` 调用 `ctx.res.clearCookie`）。
 */
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";

/**
 * tRPC 请求上下文。
 *
 * - `req` / `res`：原始 Express 对象，用于 cookie 操作、读取 header、拿客户端 IP。
 * - `user`：当前登录用户的**完整数据库行**（drizzle `users` 表推导类型），
 *   未登录或鉴权失败时为 `null`。在 `protectedProcedure` / `adminProcedure`
 *   下会被中间件收窄为非空 `User`。
 */
export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
};

/**
 * 构建单次 tRPC 请求的上下文。
 *
 * 流程：尝试用 session cookie 鉴权 → 成功则挂载 User 行，失败则挂 null。
 *
 * 副作用（发生在 `sdk.authenticateRequest` 内部）：
 * - 读库：`getUserByOpenId`；
 * - 写库：`upsertUser` 更新 `lastSignedIn`；
 * - 可能发起外部 HTTP：本地无该用户时调 OAuth 服务器的 `GetUserInfoWithJwt` 回填。
 *
 * @param opts tRPC Express adapter 提供的 `{ req, res }`
 * @returns 上下文对象；**本函数永不抛错**（鉴权异常一律降级为匿名）
 */
export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: User | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    // 有意吞掉异常且不记日志：未登录访问是正常流量，打日志会淹没有效信息。
    // 副作用是真正的故障（如 DB 不可用导致鉴权失败）也会被静默降级为"未登录"，
    // 表现为用户莫名被登出而服务端无任何痕迹 —— 排查此类问题需看 sdk 内部的 warn 日志。
    user = null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
