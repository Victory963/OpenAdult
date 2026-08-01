/**
 * shared/_core/errors.ts —— 跨端 HTTP 错误类型（架构分层：shared/_core 框架核心）
 *
 * ## 角色
 * 定义一个带 HTTP 状态码的错误基类 `HttpError`，让业务代码可以「抛出语义化错误」
 * 而不必在每个 Express handler 里手写 `res.status(403).json(...)`。位于 `_core/`
 * 目录，属于框架基础设施，按项目约定**不要随意修改**。
 *
 * ## 主要导出物
 * - `HttpError` —— 错误基类，携带 `statusCode` 与 `message`。
 * - `BadRequestError(msg)`   → 400
 * - `UnauthorizedError(msg)` → 401
 * - `ForbiddenError(msg)`    → 403
 * - `NotFoundError(msg)`     → 404
 *   这四个是**工厂函数而非子类**：调用方写 `throw ForbiddenError("...")`（不带 `new`）。
 *
 * ## 上下游依赖
 * - 下游：无（仅依赖内置 `Error`）。
 * - 上游（谁在用）：
 *   - `server/_core/sdk.ts` —— `getUser()` 在 cookie 缺失/无效、回源同步用户失败、
 *     用户仍不存在这三种情况下 `throw ForbiddenError(...)`；
 *   - `shared/types.ts` —— 作为值导出转发出去（前端可 `instanceof HttpError` 判定）。
 *
 * ## 关键设计决策 / 坑
 * 1. **工厂函数返回的都是 `HttpError` 本身，不是各自的子类**，所以无法用
 *    `err instanceof NotFoundError` 区分类型，只能判断 `err.statusCode === 404`。
 * 2. **`statusCode` 目前在整个仓库中没有任何读取方**：`server/_core/index.ts` 没有注册
 *    Express 错误处理中间件，tRPC 的 `errorFormatter` 也不认识 `HttpError`。因此
 *    sdk.ts 抛出的 `ForbiddenError` 实际上不会变成 HTTP 403，会退化成
 *    tRPC 的 `INTERNAL_SERVER_ERROR`（500）。想让状态码生效需要额外补一层
 *    `app.use((err, req, res, next) => ...)`。
 * 3. 没有 `captureStackTrace` 处理，栈顶会包含工厂函数这一帧。
 */

/**
 * Base HTTP error class with status code.
 * Throw this from route handlers to send specific HTTP errors.
 *
 * 带 HTTP 状态码的错误基类。
 *
 * @param statusCode 期望返回给客户端的 HTTP 状态码（通过 `public` 参数属性直接挂到实例上）
 * @param message    错误描述，会传给 `Error` 基类；注意它可能被序列化后暴露给前端，
 *                   不要在里面拼接密钥、token、SQL 等敏感信息
 *
 * @remarks
 * 构造函数里把 `this.name` 覆写成 `"HttpError"`（默认会是 `"Error"`），这样日志和
 * `err.toString()` 才能显示成 `HttpError: xxx`。由于是 ES2015+ class 继承内置 `Error`，
 * 在 tsconfig target 为 ES5 时 `instanceof HttpError` 会失效——本项目 target 为
 * 现代 ES 且用 esbuild/vite 打包，因此没有这个问题。
 */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    // 覆写 name，使日志输出为 "HttpError: xxx" 而非 "Error: xxx"
    this.name = "HttpError";
  }
}

// Convenience constructors
// 便捷构造器：均返回 HttpError 实例（非子类），调用时**不加 `new`**，
// 用法为 `throw BadRequestError("参数缺失")`。

/** 400 Bad Request —— 入参校验失败、请求体格式错误等客户端问题。 */
export const BadRequestError = (msg: string) => new HttpError(400, msg);
/** 401 Unauthorized —— 未携带凭证 / 凭证已过期，语义上应引导前端去登录。 */
export const UnauthorizedError = (msg: string) => new HttpError(401, msg);
/** 403 Forbidden —— 已认证但权限不足，或会话 cookie 无效（sdk.ts 的 `getUser()` 用它）。 */
export const ForbiddenError = (msg: string) => new HttpError(403, msg);
/** 404 Not Found —— 目标资源（视频、女优、上传会话等）不存在。 */
export const NotFoundError = (msg: string) => new HttpError(404, msg);
