/**
 * ============================================================================
 * server/_core/systemRouter.ts — 系统级 tRPC 子路由（健康检查 + 站长通知）
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— API 路由层**。
 * 挂载点：`server/routers.ts` 的根路由中（前端调用形如
 * `trpc.system.health.useQuery(...)`、`trpc.system.notifyOwner.useMutation()`）。
 *
 * ## 主要导出
 * - `systemRouter` —— 含两个 procedure：
 *     | procedure     | 权限   | 类型     | 用途 |
 *     |---------------|--------|----------|------|
 *     | `health`      | public | query    | 探活，验证 tRPC 链路（含序列化）可用 |
 *     | `notifyOwner` | admin  | mutation | 向站长推送通知（Forge 网关下发） |
 *
 * ## 上下游依赖
 * - 上游：`server/routers.ts`。
 * - 下游：`./notification`（`notifyOwner`）、`./trpc`（procedure 工厂）、`zod`（入参校验）。
 *
 * ## 与 `/health` 端点的区别
 * `server/_core/index.ts` 里的 `GET /health` 是给 Docker healthcheck 用的裸 HTTP 探针；
 * 这里的 `system.health` 走完整 tRPC 管线（context 构建 + superjson 编解码），
 * 用于确认**应用层**而非仅进程存活。注意它因此会触发 `createContext`，
 * 连带产生一次鉴权查库/写库 —— 不适合做高频轮询探活。
 */
import { z } from "zod";
import { notifyOwner } from "./notification";
import { adminProcedure, publicProcedure, router } from "./trpc";

export const systemRouter = router({
  /**
   * 健康探测。权限：**public**。
   *
   * 入参 `timestamp` 并不参与任何逻辑，纯粹作为"回声"负载存在：
   * 客户端传一个非负毫秒时间戳，用来验证请求体确实被 superjson 正确编解码，
   * 同时可作为 cache-buster 防止中间层缓存该 query。
   *
   * @returns 恒为 `{ ok: true }`
   * @throws {TRPCError} BAD_REQUEST —— timestamp 为负数时由 zod 拦截
   */
  health: publicProcedure
    .input(
      z.object({
        timestamp: z.number().min(0, "timestamp cannot be negative"),
      })
    )
    .query(() => ({
      ok: true,
    })),

  /**
   * 向站长（`ENV.ownerOpenId`）推送一条通知。权限：**admin**。
   *
   * 副作用：调用 Forge 网关的 `SendNotification` 接口发起外部 HTTP 请求。
   * `./notification` 内部另有更严格的长度上限（title 1200 / content 20000 字符）
   * 并会做 trim，这里的 zod 只保证非空，两层校验都可能拒绝请求。
   *
   * @param input.title   通知标题，非空
   * @param input.content 通知正文，非空
   * @returns `{ success }` —— 投递结果；注意投递失败时是返回 `success: false`
   *          而非抛错，调用方必须检查该字段
   * @throws {TRPCError} FORBIDDEN（非管理员）、BAD_REQUEST（字段为空或超长）
   */
  notifyOwner: adminProcedure
    .input(
      z.object({
        title: z.string().min(1, "title is required"),
        content: z.string().min(1, "content is required"),
      })
    )
    .mutation(async ({ input }) => {
      const delivered = await notifyOwner(input);
      // `as const` 让返回类型收窄为字面量结构，前端拿到精确的 { success: boolean }。
      return {
        success: delivered,
      } as const;
    }),
});
