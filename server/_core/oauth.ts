/**
 * ============================================================================
 * server/_core/oauth.ts — Manus OAuth 回调路由（登录闭环的服务端一半）
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— HTTP 路由层**。
 * 这是全项目**唯一**的非 tRPC 认证入口，因为 OAuth 回调是浏览器 302 导航
 * （而非 XHR），必须是一个可被重定向命中的普通 GET 路由。
 *
 * ## 完整登录时序
 * ```
 * 1. 前端跳转 VITE_OAUTH_PORTAL_URL（携带 state = base64(redirectUri)）
 * 2. 用户在 Manus 侧完成授权
 * 3. Manus 302 回跳 → GET /api/oauth/callback?code=...&state=...   ← 本文件
 * 4. code + state 换 accessToken（ExchangeToken）
 * 5. accessToken 换用户信息（GetUserInfo）
 * 6. upsertUser 落库
 * 7. 自签一个 HS256 JWT 作为 session，写入 httpOnly cookie
 * 8. 302 重定向到 "/"，前端 auth.me 拿到登录态
 * ```
 *
 * ## 主要导出
 * - `registerOAuthRoutes(app)` —— 在 Express app 上注册 `/api/oauth/callback`。
 *
 * ## 上下游依赖
 * - 上游：`server/_core/index.ts` 在装配阶段调用。
 * - 下游：`./sdk`（换 token / 取用户信息 / 签 session）、`../db`（`upsertUser`）、
 *         `./cookies`（cookie 属性）、`@shared/const`（cookie 名与有效期）。
 *
 * ## 关键设计决策 / 坑
 * - **session 与 OAuth token 解耦**：accessToken 用完即弃（不落库、不下发给浏览器），
 *   浏览器持有的是本站自签的 JWT。好处是后续请求无需回调 OAuth 服务器；
 *   代价是**无法远程吊销** —— JWT 一旦签发，在有效期内始终有效。
 * - **有效期 1 年（`ONE_YEAR_MS`）**：cookie `maxAge` 与 JWT `exp` 保持一致。
 *   对成人站点的"少登录"体验诉求是有意为之，但配合上一条即意味着
 *   泄露的 cookie 可被滥用长达一年。
 * - **回调后固定重定向到 `/`**：`state` 里的 redirectUri 只用于换 token 时的
 *   参数校验，并未用来决定登录后的落地页，因此用户会丢失登录前所在的页面。
 */
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { Express, Request, Response } from "express";
import * as db from "../db";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";

/**
 * 安全读取单个 query 参数。
 *
 * Express 对重复出现的同名参数（`?code=a&code=b`）会解析成数组，对
 * `?code[x]=1` 会解析成对象。这里用 `typeof === "string"` 过滤掉这两种情况，
 * 避免把数组/对象误当字符串传进下游拼 URL 或做 base64 解码，属于基础的
 * HTTP 参数污染（HPP）防护。
 *
 * @param req Express 请求
 * @param key 参数名
 * @returns 参数值；非字符串形态一律返回 undefined
 */
function getQueryParam(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * 注册 OAuth 相关路由。
 *
 * 权限级别：**public** —— 回调必须匿名可访问（此时用户尚未有 session）。
 *
 * 副作用：注册 `GET /api/oauth/callback`；该路由被命中时会写数据库、
 * 调用外部 OAuth 服务、下发 Set-Cookie 并 302 重定向。
 *
 * @param app Express 应用实例
 */
export function registerOAuthRoutes(app: Express) {
  app.get("/api/oauth/callback", async (req: Request, res: Response) => {
    // code：一次性授权码；state：base64 编码的 redirectUri，
    // 换 token 时必须原样回传给 OAuth 服务器做 redirect_uri 一致性校验。
    // 注意：state 在此处**未**与服务端保存的随机值比对，因此不具备 CSRF 防护作用，
    // 它在本实现中纯粹是 redirectUri 的传输载体。
    const code = getQueryParam(req, "code");
    const state = getQueryParam(req, "state");

    if (!code || !state) {
      res.status(400).json({ error: "code and state are required" });
      return;
    }

    try {
      // 步骤 4~5：两次串行的外部调用，任一失败都会落入下方 catch。
      // 各带 30s 超时（AXIOS_TIMEOUT_MS），最坏情况本请求阻塞约 60s。
      const tokenResponse = await sdk.exchangeCodeForToken(code, state);
      const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);

      // openId 是本站的用户主键（users.openId），缺失则无法建立账号，直接 400。
      if (!userInfo.openId) {
        res.status(400).json({ error: "openId missing from user info" });
        return;
      }

      // 步骤 6：写库。upsert 语义 —— 首次登录插入，再次登录更新资料与 lastSignedIn。
      // 注意这里不写 role 字段，故新用户一律为默认的 'user'，管理员需手工改库提权。
      await db.upsertUser({
        openId: userInfo.openId,
        // name 用 `||` 而非 `??`：空字符串也要归一为 null，避免库里存无意义的 ""。
        name: userInfo.name || null,
        email: userInfo.email ?? null,
        // loginMethod 优先取 sdk 归一化后的值，回退到原始 platform 字段（见 sdk.deriveLoginMethod）。
        loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
        lastSignedIn: new Date(),
      });

      // 步骤 7：签发本站自有的 session JWT（HS256，密钥为 ENV.cookieSecret）。
      // payload 只含 openId / appId / name —— 刻意不含 role，
      // 因为角色需要实时生效，每次请求都从数据库读取（见 sdk.authenticateRequest）。
      const sessionToken = await sdk.createSessionToken(userInfo.openId, {
        name: userInfo.name || "",
        expiresInMs: ONE_YEAR_MS,
      });

      // cookie 的 maxAge 与 JWT 的 exp 必须一致，否则会出现
      // "cookie 还在但 JWT 已过期"（表现为莫名 401）或反之的不一致状态。
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });

      // 步骤 8：回首页。用 302 而非 200+HTML，保证浏览器地址栏不残留 code/state。
      res.redirect(302, "/");
    } catch (error) {
      // 兜底：token 交换失败、OAuth 服务器超时、数据库写入失败都会到这里。
      // 对用户表现为一个 JSON 错误页而非友好的登录失败提示 —— 属已知体验缺口。
      console.error("[OAuth] Callback failed", error);
      res.status(500).json({ error: "OAuth callback failed" });
    }
  });
}
