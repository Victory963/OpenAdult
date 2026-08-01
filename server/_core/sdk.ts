/**
 * ============================================================================
 * server/_core/sdk.ts — Manus OAuth SDK + 本站 session 签发/校验
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 鉴权服务层**。
 * 封装了两件事，且它们是**互相独立**的两套凭证体系：
 *
 * ```
 * ┌── 对外：Manus OAuth 服务器（Connect-RPC over HTTP POST） ──┐
 * │  ExchangeToken       code + state      → accessToken       │
 * │  GetUserInfo         accessToken       → 用户资料           │
 * │  GetUserInfoWithJwt  本站 session JWT  → 用户资料           │
 * └────────────────────────────────────────────────────────────┘
 * ┌── 对内：本站自签 session（jose / HS256） ──────────────────┐
 * │  signSession / createSessionToken  → JWT 字符串             │
 * │  verifySession                     → payload 或 null       │
 * │  authenticateRequest               → 数据库 User 行         │
 * └────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## 主要导出
 * - `SessionPayload` —— 本站 session JWT 的 payload 形状（openId / appId / name）。
 * - `sdk` —— `SDKServer` 的**进程级单例**，模块加载时即构造（连带创建 axios 实例）。
 *
 * ## 上下游依赖
 * - 上游调用方：`./context`（`authenticateRequest`）、`./oauth`
 *   （`exchangeCodeForToken` / `getUserInfo` / `createSessionToken`）。
 * - 下游依赖：`./env`（appId / cookieSecret / oAuthServerUrl）、`../db`
 *   （`getUserByOpenId` / `upsertUser`）、`jose`（JWT）、`axios`（HTTP）、
 *   `cookie`（解析 Cookie header）。
 *
 * ## 关键设计决策 / 坑
 * - **RPC 路径是 Connect/gRPC-Web 风格**：`/webdev.v1.WebDevAuthPublicService/XxxYyy`，
 *   全部使用 POST + JSON body，不是 REST。
 * - **`GetUserInfoWithJwt` 接受的是本站签发的 JWT**：意味着 OAuth 服务器与本站
 *   共享 `JWT_SECRET`（或至少能验证它）。这是 `authenticateRequest` 里
 *   "本地无此用户 → 用 cookie 回源补资料" 这条自愈路径成立的前提。
 * - **无 refreshToken 流程**：accessToken 用完即弃，登录态完全由本站 JWT 承载。
 * - **单例的副作用**：`new SDKServer()` 在模块顶层执行，构造函数里有 console 输出，
 *   因此任何 import 本模块的地方（包括测试）都会触发一次 OAuth 配置日志。
 */
import { AXIOS_TIMEOUT_MS, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import type {
  ExchangeTokenRequest,
  ExchangeTokenResponse,
  GetUserInfoResponse,
  GetUserInfoWithJwtRequest,
  GetUserInfoWithJwtResponse,
} from "./types/manusTypes";
// Utility function
/** 类型守卫：非空字符串。用于校验 JWT payload 字段（`jwtVerify` 返回的是 unknown）。 */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/**
 * 本站 session JWT 的 payload。
 *
 * 刻意保持极简：
 * - `openId`：用户主键，后续据此查库；
 * - `appId`：签发方应用标识（`verifySession` **不**校验它，也**未**比对 `ENV.appId`）；
 * - `name`：仅为免查库展示昵称而冗余，非权威数据，允许为空串。
 *
 * **不含 `role`** —— 权限必须实时反映数据库，避免降权后旧 token 仍是管理员。
 */
export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

// Manus OAuth 服务器的 Connect-RPC 端点路径（全部 POST + JSON）。
const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
const GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;

/**
 * Manus OAuth 服务器的薄封装 —— 只负责拼请求体与发 HTTP，不做任何业务处理。
 *
 * 内部类，不导出；外部统一通过 `SDKServer`（即单例 `sdk`）间接使用。
 */
class OAuthService {
  /**
   * @param client 预配置了 baseURL 与超时的 axios 实例（由 `createOAuthHttpClient` 提供）
   *
   * 副作用：打印初始化日志；`OAUTH_SERVER_URL` 未配置时打 error 日志，
   * 但**不抛错** —— 进程照常启动，直到真正登录时才会以网络错误的形式暴露。
   */
  constructor(private client: ReturnType<typeof axios.create>) {
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }

  /**
   * 从 OAuth `state` 参数还原出 redirectUri。
   *
   * 约定：前端发起授权时把 redirectUri 做 base64 后放进 `state`，
   * 这里用 `atob` 解回。之所以借道 state 而非直接传 redirect_uri，
   * 是因为回调链路上只有 state 会被 OAuth 服务器原样带回。
   *
   * 坑：`atob` 对非法 base64 会**抛 InvalidCharacterError**，且此处未做 try/catch，
   * 异常会一路冒泡到 `oauth.ts` 的 catch，最终表现为 500 而非 400。
   * 另外 `atob` 只能正确处理 latin1，redirectUri 含非 ASCII 时会乱码
   * （URL 本身应为 ASCII，实践中不成问题）。
   *
   * @param state base64 编码的 redirectUri
   * @returns 解码后的 redirectUri
   */
  private decodeState(state: string): string {
    const redirectUri = atob(state);
    return redirectUri;
  }

  /**
   * 用授权码换 accessToken（OAuth authorization_code 流程）。
   *
   * `redirectUri` 必须与授权阶段提交的完全一致，否则 OAuth 服务器会拒绝 —— 这
   * 正是要把它藏在 state 里带一圈回来的原因。请求未带 clientSecret（公开客户端模式）。
   *
   * @param code  一次性授权码（只能使用一次）
   * @param state base64(redirectUri)
   * @returns 含 accessToken / expiresIn / idToken 等的响应
   * @throws axios 网络错误或非 2xx 响应；state 非法 base64 时抛 InvalidCharacterError
   */
  async getTokenByCode(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    const payload: ExchangeTokenRequest = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state),
    };

    const { data } = await this.client.post<ExchangeTokenResponse>(
      EXCHANGE_TOKEN_PATH,
      payload
    );

    return data;
  }

  /**
   * 用 accessToken 拉取用户资料。
   *
   * 形参类型是整个 `ExchangeTokenResponse`，但实际只取用 `accessToken` 一个字段
   * ——因此 `SDKServer.getUserInfo` 里才需要 `{ accessToken } as ExchangeTokenResponse`
   * 这样的断言来伪造一个"只有一个字段"的对象。
   *
   * @param token 至少包含 accessToken 的 token 响应
   * @returns 原始用户资料（openId / name / email / platform ...，尚未做 loginMethod 归一化）
   * @throws axios 网络错误或非 2xx 响应
   */
  async getUserInfoByToken(
    token: ExchangeTokenResponse
  ): Promise<GetUserInfoResponse> {
    const { data } = await this.client.post<GetUserInfoResponse>(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken,
      }
    );

    return data;
  }
}

/**
 * 创建访问 OAuth 服务器的 axios 实例。
 *
 * `baseURL` 在**模块加载时**求值，运行期改 `OAUTH_SERVER_URL` 无效。
 * `timeout` 取共享常量 `AXIOS_TIMEOUT_MS`（30 秒）—— 对认证类调用偏长，
 * 意味着 OAuth 服务器无响应时，登录回调最坏会挂住约 60 秒（两次串行调用）。
 * 未配置重试：认证请求不幂等（授权码只能用一次），重试可能引发二次消费。
 */
const createOAuthHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.oAuthServerUrl,
    timeout: AXIOS_TIMEOUT_MS,
  });

/**
 * 对外统一的 SDK 门面：既代理 OAuth 调用，也负责本站 session 的签发与校验。
 *
 * 以单例 `sdk` 的形式导出（见文件末尾）。构造函数可注入 axios 实例，
 * 便于测试时替换为 mock。
 */
class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OAuthService;

  /**
   * @param client 可选的 axios 实例；默认创建指向 `ENV.oAuthServerUrl` 的实例。
   *               注入点主要为单元测试预留。
   */
  constructor(client: AxiosInstance = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }

  /**
   * 把 OAuth 服务器返回的 `platforms` 数组归一为单个登录方式字符串。
   *
   * 规则（按优先级短路）：
   * 1. 若上游已直接给出非空的 `platform`/`loginMethod`（fallback 参数），直接采用；
   * 2. 否则在 `platforms` 集合中**按固定优先级**匹配：
   *    email > google > apple > microsoft/azure > github；
   *    这个顺序代表"最能标识用户身份来源"的偏好，并非上游返回顺序 ——
   *    一个账号可能同时绑定多个平台，必须有确定性的选择规则，否则
   *    每次登录写库的 loginMethod 会抖动。
   * 3. 仍无匹配则取集合中任意一个转小写（去重后的第一个），保证有值而非 null；
   * 4. 彻底没有则返回 null。
   *
   * MICROSOFT 与 AZURE 两个枚举合并为 "microsoft"：上游历史上用过两种命名，
   * 对本站是同一种登录方式。
   *
   * @param platforms 上游的平台枚举数组（形如 `REGISTERED_PLATFORM_GOOGLE`），类型不可信故为 unknown
   * @param fallback  上游直接给出的登录方式，优先级最高
   * @returns 归一化后的小写登录方式，或 null
   */
  private deriveLoginMethod(
    platforms: unknown,
    fallback: string | null | undefined
  ): string | null {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    // 过滤非字符串元素后去重：上游可能返回重复项，Set 同时满足去重与 O(1) 查表。
    const set = new Set<string>(
      platforms.filter((p): p is string => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (
      set.has("REGISTERED_PLATFORM_MICROSOFT") ||
      set.has("REGISTERED_PLATFORM_AZURE")
    )
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    // 兜底：未在优先级表中的新平台，直接取首个原样小写
    // （形如 "registered_platform_xxx"，与上面的短名不同构，前端展示时需注意）。
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }

  /**
   * Exchange OAuth authorization code for access token
   *
   * 登录时序第 4 步。`OAuthService.getTokenByCode` 的公开转发。
   *
   * @param code  一次性授权码
   * @param state base64(redirectUri)
   * @returns token 响应
   * @throws 网络/协议错误；state 非法 base64 时抛 InvalidCharacterError
   *
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    return this.oauthService.getTokenByCode(code, state);
  }

  /**
   * Get user information using access token
   *
   * 登录时序第 5 步。在原始响应之上做一次 `loginMethod` 归一化：
   * 把上游可能返回的 `platforms` 数组压平成单值，并**同时覆写** `platform`
   * 与 `loginMethod` 两个字段为同一个值，使调用方（`oauth.ts` 的
   * `userInfo.loginMethod ?? userInfo.platform`）无论读哪个都拿到一致结果。
   *
   * 类型上大量使用 `as any`：`GetUserInfoResponse` 未声明 `platforms` 字段，
   * 但上游实际会返回它 —— 属于本地类型定义滞后于服务端契约的临时兜底。
   *
   * @param accessToken OAuth 访问令牌
   * @returns 归一化后的用户资料
   * @throws 网络/协议错误
   *
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken: string): Promise<GetUserInfoResponse> {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken,
    } as ExchangeTokenResponse);
    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoResponse;
  }

  /**
   * 解析 Cookie 请求头为 Map。
   *
   * 返回 Map 而非普通对象，是为了避免原型链污染
   * （cookie 名可以是 `__proto__`、`constructor` 等，用对象接会踩坑）。
   *
   * @param cookieHeader 原始 `Cookie` header，缺失时返回空 Map
   */
  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  /**
   * 取 HS256 签名密钥（jose 要求 Uint8Array 形式的对称密钥）。
   *
   * 注意：`ENV.cookieSecret` 由 `env.ts` 的 `resolveCookieSecret()` 保证**非空**
   * （`JWT_SECRET` 未配置时：生产环境启动即抛错，非生产环境退化为一次性随机密钥）。
   * 这条保证是必要的 —— 空串会被编码成零长度密钥，jose 仍会照常签发与验证，
   * 于是任何人都能用公开可推导的密钥伪造 session。
   *
   * 每次调用都重新编码一次，未做缓存；相对 JWT 签验本身开销可忽略。
   */
  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a Manus user openId
   *
   * 登录时序第 7 步。在 `signSession` 之上补全 `appId`（取自 `ENV.appId`）
   * 并把 `name` 缺省为空串，是 `oauth.ts` 实际使用的入口。
   *
   * @param openId  用户主键
   * @param options `expiresInMs` 有效期（默认 `ONE_YEAR_MS`）、`name` 昵称
   * @returns 已签名的 JWT 字符串（将作为 cookie 值下发）
   *
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || "",
      },
      options
    );
  }

  /**
   * 用 HS256 签发 session JWT。
   *
   * 注意几个细节：
   * - `exp` 必须是**秒**级 Unix 时间戳，而内部计算用的是毫秒，故要
   *   `Math.floor(ms / 1000)` 转换 —— 传毫秒会得到一个几万年后的过期时间。
   * - 未设置 `iat`/`nbf`/`iss`/`aud`，`verifySession` 相应地也不校验它们。
   * - 默认有效期一年，且**无 refresh 机制**：token 无法主动吊销，
   *   改密钥（`JWT_SECRET`）是唯一的全局登出手段。
   *
   * @param payload 会被原样写入 JWT claims 的 openId / appId / name
   * @param options `expiresInMs` 有效期毫秒数，默认 `ONE_YEAR_MS`
   * @returns 紧凑序列化的 JWT 字符串
   */
  async signSession(
    payload: SessionPayload,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    return new SignJWT({
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  /**
   * 校验 session JWT 并取出 payload。
   *
   * 显式限定 `algorithms: ["HS256"]` 是必须的安全措施：不限制算法会让攻击者
   * 通过把 header 改成 `alg: "none"` 或非对称算法来绕过验签（经典的 JWT alg 混淆攻击）。
   * `jwtVerify` 同时会自动校验 `exp` 是否过期。
   *
   * 验签通过后仍要做一次字段检查：JWT 只保证"没被篡改"，不保证 payload 结构符合预期
   * （例如旧版本签发的 token 可能缺字段）。但**只有 `openId` 是必填**——它是唯一的鉴权依据；
   * `appId` / `name` 缺失或非字符串时归一为 `""` 而不判为无效，以免与签发侧不对称（见函数体注释）。
   *
   * 注意：**未校验 `appId` 是否等于 `ENV.appId`**，因此同一个 `JWT_SECRET`
   * 下其他应用签发的 token 在本站同样有效。
   *
   * @param cookieValue cookie 中的 JWT 字符串，可为空
   * @returns 校验通过返回 `{ openId, appId, name }`（后两者可能是空串）；
   *          任何失败（缺失/过期/篡改/缺 openId）**均返回 null 而不抛错**
   */
  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<{ openId: string; appId: string; name: string } | null> {
    if (!cookieValue) {
      // 匿名访问会走到这里，属正常流量却打了 warn —— 生产日志中此行噪声较大。
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name } = payload as Record<string, unknown>;

      // 修复：只有 openId 是鉴权依据，必须非空；appId / name 放宽为可选。
      // 原实现要求三者都是非空字符串，与签发侧不对称，导致必然的登录死循环：
      // - `createSessionToken` 用 `name: options.name || ""` 签发，OAuth 资料无昵称的用户
      //   拿到的 token 100% 通不过自身校验（回调成功、cookie 已种，但每个请求都被判为匿名，
      //   重复登录也无法解决）；
      // - `appId` 取自 `ENV.appId`，`VITE_APP_ID` 未配置时同样是 ""，会让**所有**用户的
      //   session 校验失败。
      // 放宽二者不损失任何安全性：appId 从未与 `ENV.appId` 比对过（非受众校验，伪造者
      //   自己填个非空值即可绕过），name 只是免查库展示用的冗余字段。
      if (!isNonEmptyString(openId)) {
        console.warn("[Auth] Session payload missing required field: openId");
        return null;
      }

      return {
        openId,
        // 缺失/非字符串统一归一为 ""，保持返回结构不变（调用方无需判类型）。
        appId: typeof appId === "string" ? appId : "",
        name: typeof name === "string" ? name : "",
      };
    } catch (error) {
      // 过期、签名不匹配、格式非法都会走到这里，统一降级为"未登录"。
      // 只记 warn 不抛错，配合 context.ts 的静默兜底，安全事件与普通过期无法区分。
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  /**
   * 用**本站签发的 session JWT** 直接向 OAuth 服务器换取用户资料。
   *
   * 用途单一：`authenticateRequest` 中发现 JWT 有效但本地库里查不到该用户时
   * （典型场景：数据库被重建、用户在其他实例上注册），用它回源补齐资料并落库，
   * 避免用户明明持有有效 cookie 却被判为未登录。
   *
   * 前提：OAuth 服务器能够验证本站的 JWT（共享 `JWT_SECRET`）。
   * 返回值同样经过 `deriveLoginMethod` 归一化，规则与 `getUserInfo` 一致。
   *
   * @param jwtToken 本站 session cookie 的值
   * @returns 归一化后的用户资料
   * @throws 网络/协议错误，或服务端拒绝该 JWT
   */
  async getUserInfoWithJwt(
    jwtToken: string
  ): Promise<GetUserInfoWithJwtResponse> {
    const payload: GetUserInfoWithJwtRequest = {
      jwtToken,
      projectId: ENV.appId,
    };

    const { data } = await this.client.post<GetUserInfoWithJwtResponse>(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );

    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoWithJwtResponse;
  }

  /**
   * 从 HTTP 请求还原出当前登录用户（**鉴权主入口**）。
   *
   * 由 `createContext` 对**每个 tRPC 请求**调用一次，流程：
   * ```
   * Cookie header → 取 app_session_id → 验签 JWT → openId
   *   → 查库 getUserByOpenId
   *       ├─ 命中：直接用
   *       └─ 未命中：GetUserInfoWithJwt 回源 → upsertUser → 再查一次（自愈路径）
   *   → upsertUser 刷新 lastSignedIn
   *   → 返回完整 User 行（含 role，供 adminProcedure 判权）
   * ```
   *
   * 副作用（**每个请求都会发生**）：
   * - 读库 1~2 次；
   * - **写库 1 次**（更新 `lastSignedIn`）—— 这是全站 QPS 的隐性写放大来源，
   *   即便是纯读接口也会产生一次 UPDATE；
   * - 自愈路径下额外一次外部 HTTP（30s 超时）。
   *
   * @param req Express 请求
   * @returns 数据库中的完整 User 行
   * @throws {HttpError} 403 ForbiddenError —— cookie 缺失/无效、回源同步失败、用户仍不存在
   */
  async authenticateRequest(req: Request): Promise<User> {
    // Regular authentication flow
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      // 这里抛错会被 context.ts 吞掉并降级为匿名，因此 403 不会直接返回给客户端。
      throw ForbiddenError("Invalid session cookie");
    }

    const sessionUserId = session.openId;
    // 统一取一次时间戳，保证下面两条写路径写入的 lastSignedIn 一致。
    const signedInAt = new Date();
    let user = await db.getUserByOpenId(sessionUserId);

    // If user not in DB, sync from OAuth server automatically
    // 自愈路径：JWT 合法但本地无记录（换库/多实例/手工清表），
    // 用同一个 cookie 回源拉资料补建，避免用户被动登出。
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
        await db.upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt,
        });
        // upsert 后必须重新查一次：需要拿到自增 id、role、createdAt 等
        // 由数据库生成/维护的字段，upsertUser 本身不回填这些。
        user = await db.getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }

    // 回源后仍查不到：可能是 openId 不一致或写库静默失败，不再重试，直接判为未登录。
    if (!user) {
      throw ForbiddenError("User not found");
    }

    // 刷新最后登录时间。注意这是 await 的（阻塞响应），且未做节流 ——
    // 每个请求一次写库，高频场景下建议改为异步 fire-and-forget 或按分钟去重。
    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    // 返回的是 upsert **之前**读到的 user 快照，故其 lastSignedIn 仍是上一次的值。
    return user;
  }
}

/**
 * 进程级单例。模块加载时立即构造（会创建 axios 实例并打印 OAuth 配置日志）。
 * 全项目统一 `import { sdk } from "./sdk"` 使用，不应再自行 new SDKServer。
 */
export const sdk = new SDKServer();
