/**
 * ============================================================================
 * server/_core/types/manusTypes.ts — Manus WebDev Auth 服务的 DTO 类型定义
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 类型契约层**，纯类型文件，零运行时代码。
 *
 * 对应服务：`webdev.v1.WebDevAuthPublicService`（Connect-RPC 风格，
 * 全部为 POST + JSON，路径形如 `/webdev.v1.WebDevAuthPublicService/<方法名>`）。
 *
 * ## 主要导出（按 RPC 方法成对组织）
 * | RPC 方法            | Request                     | Response                     | 本项目是否使用 |
 * |---------------------|-----------------------------|------------------------------|---------------|
 * | Authorize           | `AuthorizeRequest`          | `AuthorizeResponse`          | 否（授权跳转由前端直接拼 URL） |
 * | ExchangeToken       | `ExchangeTokenRequest`      | `ExchangeTokenResponse`      | 是（`sdk.getTokenByCode`） |
 * | GetUserInfo         | `GetUserInfoRequest`        | `GetUserInfoResponse`        | 是（`sdk.getUserInfoByToken`，但请求体由 ExchangeTokenResponse 断言而来） |
 * | CanAccess           | `CanAccessRequest`          | `CanAccessResponse`          | 否（未接入访问控制） |
 * | GetUserInfoWithJwt  | `GetUserInfoWithJwtRequest` | `GetUserInfoWithJwtResponse` | 是（`sdk.getUserInfoWithJwt` 自愈路径） |
 *
 * ## 上下游依赖
 * - 上游：仅 `server/_core/sdk.ts` 引用。
 * - 下游：无。
 *
 * ## 关键设计决策 / 坑
 * - **由 protobuf 自动生成**（见下方生成时间戳），字段名已从 proto 的 snake_case
 *   转为 camelCase。**请勿手工修改** —— 重新生成会覆盖。
 * - **本地定义已滞后于服务端实际契约**：真实响应还包含一个 `platforms: string[]`
 *   字段（多平台绑定列表），此处未声明，因此 `sdk.ts` 中不得不用
 *   `(data as any)?.platforms` 绕过类型检查。若要重新生成，注意补上该字段。
 * - `loginMethod` 并非上游原始字段，而是 `sdk.deriveLoginMethod` 归一化后
 *   附加上去的；它出现在这里是为了让 sdk 的返回值类型自洽。
 */
// WebDev Auth TypeScript types
// Auto-generated from protobuf definitions
// Generated on: 2025-09-24T05:57:57.338Z

/**
 * Authorize 请求：换取授权页 URL。
 * 本项目**未使用** —— 前端直接用 `VITE_OAUTH_PORTAL_URL` 拼跳转地址。
 *
 * - `state`：本项目约定为 `base64(redirectUri)`，回调时原样带回（见 `sdk.decodeState`）。
 * - `responseType`：OAuth 标准字段，此流程下为 `"code"`。
 */
export interface AuthorizeRequest {
  redirectUri: string;
  projectId: string;
  state: string;
  responseType: string;
  scope: string;
}

/** Authorize 响应：应重定向到的授权页地址。本项目未使用。 */
export interface AuthorizeResponse {
  redirectUrl: string;
}

/**
 * ExchangeToken 请求：授权码换 token。
 *
 * - `grantType`：本项目固定传 `"authorization_code"`（不走 refresh_token 流程）。
 * - `clientId`：即 `ENV.appId`。
 * - `clientSecret`：可选，本项目**不传** —— 按公开客户端（public client）模式接入，
 *   安全性依赖 redirectUri 白名单校验而非密钥。
 * - `redirectUri`：必须与授权阶段完全一致，否则服务端拒绝。
 */
export interface ExchangeTokenRequest {
  grantType: string;
  code: string;
  refreshToken?: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/**
 * ExchangeToken 响应。
 *
 * 本项目只消费 `accessToken` 一个字段，且用完即弃（不落库、不下发浏览器）——
 * 登录态改由本站自签的 session JWT 承载，因此 `refreshToken` / `expiresIn`
 * 均被忽略，也就没有 token 续期逻辑。
 *
 * - `expiresIn`：**秒**为单位的有效期（OAuth 标准语义），非毫秒。
 */
export interface ExchangeTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  scope: string;
  idToken: string;
}

/**
 * GetUserInfo 请求。
 *
 * 注意：`sdk.getUserInfoByToken` 的形参类型写的是 `ExchangeTokenResponse`
 * 而非本类型，故调用处需要 `{ accessToken } as ExchangeTokenResponse` 断言。
 */
export interface GetUserInfoRequest {
  accessToken: string;
}

/**
 * GetUserInfo 响应（用户资料）。
 *
 * - `openId`：**本站用户主键**（`users.openId`），跨会话稳定。
 * - `name`：昵称，上游可能返回空串 —— 会被 `oauth.ts` 归一为 null 落库。
 * - `platform` / `loginMethod`：经 `sdk.deriveLoginMethod` 归一化后**被覆写为同一个值**。
 *
 * 缺失声明：实际响应还含 `platforms: string[]`，见文件头说明。
 */
export interface GetUserInfoResponse {
  openId: string;
  projectId: string;
  name: string;
  email?: string | null;
  platform?: string | null;
  loginMethod?: string | null;
}

/** CanAccess 请求：查询某用户对某项目是否有访问权。本项目未接入。 */
export interface CanAccessRequest {
  openId: string;
  projectId: string;
}

/** CanAccess 响应。本项目未接入 —— 访问控制完全由本站 `users.role` 决定。 */
export interface CanAccessResponse {
  canAccess: boolean;
}

/**
 * GetUserInfoWithJwt 请求：用**本站签发的 session JWT** 换用户资料。
 *
 * 该能力成立的前提是 OAuth 服务器能验证本站 JWT（共享 `JWT_SECRET`）。
 * 用于 `sdk.authenticateRequest` 的自愈路径：JWT 有效但本地库无此用户时回源补建。
 *
 * - `projectId`：传 `ENV.appId`。
 */
export interface GetUserInfoWithJwtRequest {
  jwtToken: string;
  projectId: string;
}

/**
 * GetUserInfoWithJwt 响应。
 * 结构与 `GetUserInfoResponse` 完全一致（protobuf 中为两个独立 message，故未合并）。
 */
export interface GetUserInfoWithJwtResponse {
  openId: string;
  projectId: string;
  name: string;
  email?: string | null;
  platform?: string | null;
  loginMethod?: string | null;
}
