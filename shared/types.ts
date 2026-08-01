/**
 * Unified type exports
 * Import shared types from this single entry point.
 *
 * ---
 *
 * shared/types.ts —— 跨端类型聚合入口（架构分层：shared / 跨端契约层）
 *
 * ## 角色
 * 作为「前端要用到的类型」的单一 re-export 出口（barrel file），把散落在
 * `drizzle/schema.ts`（数据库行类型）和 `shared/_core/errors.ts`（HTTP 错误类型）
 * 的定义收敛到 `@shared/types` 一个模块路径下，避免前端代码直接深入 `drizzle/` 目录。
 *
 * ## 主要导出物
 * - `export type * from "../drizzle/schema"` —— 转发全部**类型**导出：
 *   `User` / `InsertUser` / `Video` / `InsertVideo` / `Actress` / `Ad` 等
 *   由 `$inferSelect` / `$inferInsert` 推导出的行类型。
 * - `export * from "./_core/errors"` —— 转发 `HttpError` 类及
 *   `BadRequestError` / `UnauthorizedError` / `ForbiddenError` / `NotFoundError` 工厂函数。
 *
 * ## 上下游依赖
 * - 下游：`../drizzle/schema`、`./_core/errors`。
 * - 上游：设计上供 `client/` 与 `server/` 双方通过路径别名 `@shared/types` 引入。
 *   （现状：仓库中暂无文件引用本模块，各处都是直接 import 具体源文件，见文末说明。）
 *
 * ## 关键设计决策 / 坑
 * 1. **`export type *` 是刻意为之，不能改成 `export *`**：`drizzle/schema.ts` 的值导出
 *    （`users`、`videos` 等 `mysqlTable` 实例）会把整个 drizzle-orm 的 MySQL 驱动
 *    链路拖进前端 bundle。只转发类型可保证编译后本行完全消失、零运行时开销。
 * 2. 与之相对，`./_core/errors` 用的是**值导出** `export *`，因为 `HttpError` 是需要
 *    在运行时 `new` / `instanceof` 的真实类，前端 bundle 里会保留这段代码。
 * 3. 本文件目前在仓库中**没有任何引用方**（属于预留的公共入口）；实际代码都是直接
 *    `import type { User } from "../../drizzle/schema"`。新增前端代码时应优先走这里。
 */

export type * from "../drizzle/schema";
export * from "./_core/errors";
