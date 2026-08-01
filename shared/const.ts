/**
 * shared/const.ts —— 前后端共享常量（架构分层：shared / 跨端契约层）
 *
 * ## 角色
 * 这里只放**同一个值必须在浏览器端和 Node 端保持字面一致**的常量。任何只有单侧
 * 使用的常量都不应该进来（单侧常量分别放在 `client/src/const.ts` 与
 * `server/_core/env.ts`）。本文件不 import 任何东西，因此可以被前端 bundle
 * 和后端 esbuild 产物同时安全引入，不会把 Node 内置模块拖进浏览器包。
 *
 * ## 主要导出物
 * | 导出 | 用途 |
 * |------|------|
 * | `COOKIE_NAME`        | 会话 cookie 名（OAuth 种 cookie / SDK 读 cookie / logout 清 cookie 三处必须同名） |
 * | `ONE_YEAR_MS`        | 会话有效期（cookie `maxAge` 与 JWT `exp` 共用同一数值） |
 * | `AXIOS_TIMEOUT_MS`   | 调用 Manus OAuth / Forge 上游服务时的 axios 超时 |
 * | `UNAUTHED_ERR_MSG`   | 未登录错误文案；前端靠**字符串相等**识别它来触发跳登录 |
 * | `NOT_ADMIN_ERR_MSG`  | 非管理员错误文案 |
 *
 * ## 上下游依赖
 * - 上游（谁引用它）：
 *   - `server/_core/oauth.ts` —— 用 `COOKIE_NAME` + `ONE_YEAR_MS` 下发会话 cookie；
 *   - `server/_core/sdk.ts` —— 用 `COOKIE_NAME` 读取会话、`ONE_YEAR_MS` 作签发默认有效期、
 *     `AXIOS_TIMEOUT_MS` 作上游 HTTP 超时；
 *   - `server/_core/trpc.ts` —— `protectedProcedure` / `adminProcedure` 中间件抛出的
 *     `TRPCError.message` 直接取这两条文案；
 *   - `server/routers.ts` 的 `auth.logout` —— 用 `COOKIE_NAME` 清 cookie；
 *   - `client/src/const.ts` —— 转发 `COOKIE_NAME` / `ONE_YEAR_MS` 给前端；
 *   - `client/src/main.tsx` —— 用 `UNAUTHED_ERR_MSG` 判定是否跳转登录页。
 * - 下游：无（纯字面量，零依赖）。
 *
 * ## 关键设计决策 / 坑
 * 1. **错误文案被当成协议使用**：前端 `main.tsx` 是用 `error.message === UNAUTHED_ERR_MSG`
 *    做的相等比较，而不是判断 tRPC 的 `code === 'UNAUTHORIZED'`。因此括号里的错误码
 *    (10001/10002) 和整条字符串都属于**跨端契约**，改动会静默破坏前端的登录重定向，
 *    并且这两条文案不能走 i18n（`client/src/locales/translations.ts` 里没有它们）。
 * 2. 管理面板的第二套认证走的是独立 cookie `admin_session_id`
 *    （硬编码在 `server/routers/admin-auth.ts` 与 `server/routers/ad-management.ts`），
 *    **不在本文件中**，两处副本需要手动保持同步。
 */

/**
 * 会话 cookie 名。OAuth 回调写入、tRPC context 读取、logout 清除三处共用此常量，
 * 修改后所有存量用户的会话会立即失效（旧 cookie 名不再被读取）。
 */
export const COOKIE_NAME = "app_session_id";

/**
 * 一年的毫秒数：1000ms × 60s × 60min × 24h × 365d = 31_536_000_000。
 * 同时用作 cookie 的 `maxAge` 和 JWT 的过期时长，保证「浏览器认为登录还在」与
 * 「服务端认为 token 还有效」两个时间点不会错位。注意未考虑闰年（按 365 天计）。
 */
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/**
 * 调用上游服务（Manus OAuth / Forge API）的 axios 超时：30 秒。
 * 对认证类调用偏长——OAuth 回调里存在「换 token + 拉用户信息」两次串行请求，
 * 最坏情况下单个 HTTP 请求会被阻塞约 60s（见 `server/_core/oauth.ts` 的注释）。
 */
export const AXIOS_TIMEOUT_MS = 30_000;

/**
 * 未登录错误文案，错误码 10001。
 * 由 `protectedProcedure` 中间件抛出，前端 `main.tsx` 用**字符串全等**匹配它来
 * 决定是否跳转 OAuth 登录页 —— 属于跨端契约，不可随意改写或翻译。
 */
export const UNAUTHED_ERR_MSG = 'Please login (10001)';

/**
 * 权限不足（非 admin 角色）错误文案，错误码 10002。
 * 由 `adminProcedure` 中间件在校验 `ctx.user.role !== 'admin'` 时抛出。
 */
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';
