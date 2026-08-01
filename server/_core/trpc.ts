/**
 * ============================================================================
 * server/_core/trpc.ts — tRPC 实例初始化与权限中间件（procedure 工厂）
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— API 基础设施层**。
 * 全项目**唯一**调用 `initTRPC` 的地方。所有 `server/routers/*` 都从这里导入
 * `router` / `publicProcedure` / `protectedProcedure` / `adminProcedure`
 * 来声明接口，因此本文件定义了整个后端的**鉴权语义**。
 *
 * ## 主要导出
 * | 导出 | 权限级别 | `ctx.user` 类型 | 失败行为 |
 * |------|---------|----------------|---------|
 * | `router`             | —        | —              | tRPC router 构造器 |
 * | `publicProcedure`    | public   | `User \| null`  | 不校验，永不失败 |
 * | `protectedProcedure` | 登录用户 | `User`（非空）  | 抛 `UNAUTHORIZED` (401) |
 * | `adminProcedure`     | 管理员   | `User`（非空）  | 抛 `FORBIDDEN` (403) |
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts` 及 `server/routers/*.ts` 中的每一个 procedure；
 *         `server/_core/systemRouter.ts`。
 * - 下游：`./context`（提供 `ctx.user`，由 session cookie 解析而来）、
 *         `@shared/const`（错误文案，前后端共用以便前端按文案/错误码分支处理）。
 *
 * ## 关键设计决策 / 坑
 * - **superjson 作为 transformer**：`Date`、`Map`、`Set`、`undefined` 等可原样跨端
 *   传输，无需手动序列化。客户端（`client/src/lib/trpc.ts`）必须配置同一个
 *   transformer，否则反序列化会静默错乱。
 * - **鉴权是"可选"的**：`createContext` 中鉴权失败不抛错而是把 `user` 置为 null，
 *   真正的拦截发生在这里的中间件。好处是 public procedure 也能拿到已登录用户信息
 *   （用于个性化），代价是每个需要登录的接口都必须显式使用 protected/admin。
 * - **中间件里的 `next({ ctx: { ...ctx, user: ctx.user } })` 不是冗余**：这一步的作用
 *   是把 `user` 的类型从 `User | null` **收窄**为 `User`，让下游 resolver 无需
 *   非空断言即可访问 `ctx.user.id`。
 * - **管理面板存在第二套认证**：`server/routers/admin-auth.ts` 使用独立密码，
 *   与这里基于 OAuth 角色的 `adminProcedure` 是两条并行的授权路径。
 */
import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

// 绑定上下文类型后创建 tRPC 实例。泛型 <TrpcContext> 决定了所有 resolver 中
// ctx 的类型；transformer 必须与前端 createTRPCClient 中的配置严格一致。
const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

/** tRPC router 构造器。用于聚合 procedure，或把子 router 嵌套进父 router。 */
export const router = t.router;

/**
 * 公开 procedure —— 不做任何鉴权。
 *
 * 适用：视频列表、搜索、女优信息等匿名可访问的读接口。
 * 注意 `ctx.user` 在这里的类型是 `User | null`，使用前必须判空。
 */
export const publicProcedure = t.procedure;

/**
 * 登录校验中间件。
 *
 * `ctx.user` 为 null（无 cookie / cookie 失效 / JWT 验签失败 / 用户同步失败）
 * 时拦截请求。错误文案取自共享常量 `UNAUTHED_ERR_MSG`（含错误码 10001），
 * 前端据此弹出登录引导。
 *
 * @throws {TRPCError} code `UNAUTHORIZED`（映射为 HTTP 401）
 */
const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  // 重新传入 user 是为了类型收窄：下游 ctx.user 变为非空的 User。
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

/**
 * 受保护 procedure —— 要求已登录。
 *
 * 适用：收藏、续播、AI 聊天、个性化推荐、用户偏好等与身份绑定的接口。
 * resolver 中 `ctx.user` 保证非空。
 */
export const protectedProcedure = t.procedure.use(requireUser);

/**
 * 管理员 procedure —— 要求 `users.role === 'admin'`。
 *
 * 适用：视频/女优/广告的增删改等管理面板接口。
 * 角色来自数据库 `users.role` 字段（mysqlEnum 'user' | 'admin'，默认 'user'），
 * 即提权只能靠直接改库，没有对外的角色变更接口。
 *
 * 未复用 `requireUser` 而是重新实现了判空 —— 因此未登录用户拿到的是
 * `FORBIDDEN`(403) 而非 `UNAUTHORIZED`(401)，前端无法据此区分"没登录"与
 * "登录了但没权限"。
 *
 * @throws {TRPCError} code `FORBIDDEN`（映射为 HTTP 403），文案含错误码 10002
 */
export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
