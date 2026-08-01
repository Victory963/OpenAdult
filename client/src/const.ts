/**
 * ============================================================================
 * client/src/const.ts — 前端常量与 OAuth 登录 URL 构造 (UI 层 / 配置)
 * ============================================================================
 *
 * 架构角色：
 *   前端侧的常量出口。一部分常量直接从 @shared/const 透传（保证前后端同源），
 *   另一部分是只有浏览器环境才能计算出来的运行时值（依赖 window.location）。
 *
 * 主要导出物：
 *   - COOKIE_NAME  : 会话 Cookie 名，转自 @shared/const，与服务端写 Cookie 时一致。
 *   - ONE_YEAR_MS  : 一年的毫秒数，转自 @shared/const，用于 Cookie/缓存有效期计算。
 *   - getLoginUrl(): 运行时拼装 Manus OAuth 授权页 URL。
 *
 * 上下游依赖：
 *   ← client/src/main.tsx（401 时跳转）
 *   ← client/src/_core/hooks/useAuth.ts（未登录重定向的默认目标）
 *   ← 各页面的"登录"按钮
 *   → @shared/const
 *
 * 关键设计决策：
 *   本站启用了域名轮换（反封锁），同一份构建产物会在多个域名下运行，
 *   因此 redirectUri **不能**在构建期写死到环境变量里，必须在运行时根据
 *   window.location.origin 现算——这正是本文件导出函数而非常量的原因。
 */

export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Generate login URL at runtime so redirect URI reflects the current origin.
/**
 * 生成 Manus OAuth 登录页完整 URL。
 *
 * @returns 形如 `${VITE_OAUTH_PORTAL_URL}/app-auth?appId=...&redirectUri=...&state=...&type=signIn`
 *          的绝对 URL 字符串，调用方通常直接赋给 window.location.href。
 * @throws  若 VITE_OAUTH_PORTAL_URL 未注入或非法，new URL() 会抛 TypeError。
 *
 * 注意：
 *   - 只能在浏览器环境调用（读取了 window.location）。
 *   - VITE_ 前缀的环境变量由 Vite 在**构建期**内联进产物，运行时改 .env 不生效，
 *     需要重新 build。
 *   - redirectUri 必须与服务端 OAuth 回调路由 /api/oauth/callback 严格对应，
 *     且需在 OAuth 平台的回调白名单中登记。
 *   - state 这里取的是 redirectUri 的 base64（btoa），OAuth 回调时服务端据此
 *     还原应跳回哪个域名——它承担的是"跨域名回跳"信息传递，而非随机 CSRF nonce。
 */
export const getLoginUrl = () => {
  const oauthPortalUrl = import.meta.env.VITE_OAUTH_PORTAL_URL;
  const appId = import.meta.env.VITE_APP_ID;
  const redirectUri = `${window.location.origin}/api/oauth/callback`;
  const state = btoa(redirectUri);

  // 用 URL + searchParams 而不是手工字符串拼接，交由浏览器完成百分号编码，
  // 避免 redirectUri 中的 "://"、"/" 被漏转义导致授权服务器拒绝。
  const url = new URL(`${oauthPortalUrl}/app-auth`);
  url.searchParams.set("appId", appId);
  url.searchParams.set("redirectUri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("type", "signIn"); // 区分注册/登录流程，本站统一走 signIn

  return url.toString();
};
