/**
 * ============================================================================
 * server/_core/env.ts — 服务端环境变量集中出口
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 配置层**。
 * 项目约定：**后端代码不得直接读 `process.env`**，一律通过本文件的 `ENV` 常量访问，
 * 以便集中管理默认值、便于检索谁在用哪个变量。
 *
 * ## 主要导出
 * - `ENV` —— 冻结时机为**模块首次加载时**的配置快照。
 *
 * ## 上下游依赖
 * - 上游调用方：`./sdk`（appId / cookieSecret / oAuthServerUrl）、
 *   `./llm`（forgeApiUrl / forgeApiKey / hereticLlmModel）、
 *   `./notification`（forgeApiUrl / forgeApiKey / ownerOpenId）、
 *   `server/db.ts`（databaseUrl）等。
 * - 下游依赖：`process.env`，由入口 `server/_core/index.ts` 的
 *   `import "dotenv/config"` 从 `.env` 载入。
 *
 * ## 关键设计决策 / 坑
 * - **快照语义**：对象在模块求值时一次性构造，运行期修改 `process.env` 不会反映到
 *   `ENV`。同时意味着**加载顺序有强依赖** —— 必须保证 dotenv 先于本模块执行，
 *   否则全部字段静默变成空串。
 * - **缺失值降级为 `""` 而非抛错**：好处是缺配置时进程仍能起来（部分功能降级），
 *   坏处是错误延后到调用点才暴露，且表现为"401 / 连接失败"等间接症状而非明确的
 *   启动期报错。**唯一的例外是 `cookieSecret`**（见 `resolveCookieSecret`）：它缺失
 *   不是"功能降级"而是"认证被完全绕过"，因此在生产环境下 fail-fast 抛错、
 *   在非生产环境下降级为一次性随机密钥，绝不会是空串。其余字段仍无必填校验。
 * - **`VITE_APP_ID` 前缀的双重身份**：`VITE_` 前缀意味着该值同时会被 Vite 注入前端
 *   bundle（公开可见）。它是 OAuth 的 client id，本身非机密，但**切勿**把
 *   `JWT_SECRET` 等机密加上 `VITE_` 前缀。
 */
import { randomBytes } from "node:crypto";

/**
 * 解析 session JWT 的 HS256 签名密钥，保证**永远不会返回空串**。
 *
 * 背景（安全）：此前 `JWT_SECRET` 缺失时该值降级为 `""`，`sdk.getSessionSecret()`
 * 会把它编码成**零长度密钥**。jose 不拒绝零长度密钥，于是签发与验签照常工作 ——
 * 任何人都能用这个公开可推导的空密钥伪造任意 `openId` 的 session，等同于完全绕过认证。
 *
 * 现在的策略：
 * - 已配置 → 原样返回；
 * - 未配置 + 生产环境（`NODE_ENV === "production"`）→ **抛错，拒绝启动**（fail-fast），
 *   把"静默的认证绕过"换成"启动期就能看见的明确报错"；
 * - 未配置 + 非生产（dev / test）→ 生成一次性随机密钥并打 error 日志。
 *   代价是进程重启后所有已签发的 session 立即失效（本地开发需重新登录），
 *   换来的是即使忘配 .env 也不存在可伪造的已知密钥。
 *
 * @returns 非空的签名密钥字符串
 * @throws Error 生产环境下未配置 `JWT_SECRET` 时
 */
function resolveCookieSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  if (secret.length > 0) return secret;

  // 修复：JWT_SECRET 缺失时不再降级为空串（空串 = 零长度 HS256 密钥 = 任何人可伪造 session）
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[ENV] JWT_SECRET is not configured. Refusing to start in production: " +
        "an empty signing secret would let anyone forge a session for any user."
    );
  }

  console.error(
    "[ENV] WARNING: JWT_SECRET is not configured. Falling back to a random " +
      "per-process secret — all sessions are invalidated on every restart. " +
      "Set JWT_SECRET before deploying."
  );
  return randomBytes(48).toString("hex");
}

export const ENV = {
  /** Manus OAuth 应用 ID（= OAuth client_id，同时写入 JWT payload 的 appId 字段）。公开值。 */
  appId: process.env.VITE_APP_ID ?? "",
  /**
   * session JWT 的 HS256 签名密钥。**机密**，泄露等同于可伪造任意用户登录态。
   * 保证非空：未配置时生产环境启动即抛错，非生产环境退化为一次性随机密钥（见 `resolveCookieSecret`）。
   */
  cookieSecret: resolveCookieSecret(),
  /** MySQL/TiDB 连接串，供 Drizzle 使用。为空时 `getDb()` 返回 null，全站进入无数据库降级模式。 */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Manus OAuth 服务器 base URL，axios 客户端的 baseURL。为空时 sdk 构造函数会打 error 日志但不阻止启动。 */
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  /** 站点所有者的 openId，用于 `notifyOwner` 定向推送通知。 */
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  /** 是否生产环境。注意判定的是严格等于 "production"，"prod" 等写法会被判为 false。 */
  isProduction: process.env.NODE_ENV === "production",
  /** Forge 网关 base URL（LLM 推理 + 通知下发共用同一网关）。 */
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  /** Forge 网关 API Key。**机密**。 */
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  /**
   * 聊天推荐 / 图像分析所用的 LLM 模型名。
   *
   * 默认值 `p-e-w/Qwen3-4B-Instruct-2507-heretic-v2` 是一个经过 abliteration
   * （去对齐）处理的 Qwen3-4B 变体 —— 本站内容领域会触发通用模型的安全拒答，
   * 故默认选用该模型以保证推荐/描述生成不被拒绝。这是唯一带非空默认值的字段，
   * 即未配置该变量时功能仍可用。
   */
  hereticLlmModel: process.env.HERETIC_LLM_MODEL ?? "p-e-w/Qwen3-4B-Instruct-2507-heretic-v2",
};
