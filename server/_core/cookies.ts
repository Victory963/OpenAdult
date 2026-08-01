/**
 * ============================================================================
 * server/_core/cookies.ts — session cookie 属性计算
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 鉴权辅助层**。
 * 唯一职责：根据当前请求推断出写 session cookie 时应使用的属性组合
 * （`httpOnly` / `path` / `sameSite` / `secure` / `domain`）。
 *
 * ## 主要导出
 * - `getSessionCookieOptions(req)` —— 返回 cookie 选项对象。
 *
 * ## 上下游依赖
 * - 上游调用方：
 *     - `server/_core/oauth.ts` —— OAuth 回调成功后 `res.cookie(COOKIE_NAME, ...)` 种 cookie；
 *     - `server/routers.ts` 的 `auth.logout` —— 清除 cookie 时必须传入**完全相同**的
 *       属性组合，否则浏览器不会认为是同一个 cookie，删除会失效。
 * - 下游依赖：无（纯函数，仅读 `req`）。
 *
 * ## 关键设计决策 / 坑
 * - **`sameSite: "none"` 是硬编码的**：OAuth 回调是从 Manus 授权服务器
 *   302 跳回本站的跨站导航，`sameSite: "lax"` 在某些浏览器/流程下会丢 cookie。
 *   但按规范 `SameSite=None` **必须**同时带 `Secure`，因此在纯 HTTP 的本地开发环境
 *   （`secure` 计算为 false）下，Chrome 会直接拒绝写入该 cookie。
 * - **`domain` 相关逻辑已被整段注释掉**：原本想把 cookie 提升到父域
 *   （`.example.com`）以便主域与轮换域名共享登录态。注释后 cookie 退化为
 *   host-only —— 这与本项目的"域名轮换反封锁"策略直接冲突：域名一换，
 *   用户登录态即丢失。下方 `LOCAL_HOSTS` 与 `isIpAddress` 因此成为死代码，
 *   保留是为了将来恢复该逻辑。
 */
import type { CookieOptions, Request } from "express";

/**
 * 本地开发主机名白名单。这些 host 不应设置 cookie `domain`
 * （浏览器不允许为 `localhost` / IP 设置带前导点的父域）。
 *
 * 注意：当前仅被已注释掉的 domain 逻辑引用，实际未生效。
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * 粗略判断 host 是否为 IP 字面量（而非域名）。
 *
 * - IPv4：`/^\d{1,3}(\.\d{1,3}){3}$/` —— 只校验"四段 1~3 位数字"的形状，
 *   **不校验每段 ≤ 255**，故 `999.999.999.999` 也会返回 true。对本用途
 *   （决定要不要设 cookie domain）足够，无需精确。
 * - IPv6：仅检测是否含 `:`。因为 `req.hostname` 已剥离端口号，冒号只可能来自
 *   IPv6 地址，所以这个粗判是安全的。
 *
 * 注意：当前仅被已注释掉的 domain 逻辑引用，实际未生效。
 *
 * @param host 主机名（不含端口）
 * @returns 形似 IP 返回 true
 */
function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

/**
 * 判断请求在**用户侧**是否为 HTTPS，用于决定 cookie 的 `Secure` 属性。
 *
 * 生产架构是 `浏览器 --https--> Cloudflare/Nginx --http--> Express`，
 * 到达 Node 时 `req.protocol` 已经是 http，因此必须回退查 `X-Forwarded-Proto`。
 * 该 header 在多层代理下形如 `"https, http"`（逗号分隔，最左为原始客户端协议），
 * 所以这里按逗号拆分后只要**任一段**为 https 即判定为安全连接。
 *
 * 前置条件：`req.protocol` 要正确反映 `X-Forwarded-Proto` 需 Express 开启
 * `trust proxy`；本项目未开启，故实际总是走 header 分支。
 *
 * 安全提示：`X-Forwarded-Proto` 是客户端可伪造的 header，只有在最外层代理
 * 会强制覆写它时才可信。
 *
 * @param req Express 请求
 * @returns 用户侧为 HTTPS 返回 true
 */
function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  // header 可能被 Node 解析成数组（同名 header 出现多次），也可能是逗号分隔的字符串，
  // 两种形态都要归一成列表再逐项 trim + 小写比较。
  const protoList = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return protoList.some(proto => proto.trim().toLowerCase() === "https");
}

/**
 * 计算 session cookie 的属性组合。
 *
 * 返回值各字段含义：
 * - `httpOnly: true` —— 禁止 JS 读取，防 XSS 窃取 session JWT。
 * - `path: "/"`      —— 全站生效（HLS、存储代理等非 tRPC 路由也需要携带）。
 * - `sameSite: "none"` —— 允许跨站请求携带，OAuth 跨站回跳所必需（见文件头说明）。
 * - `secure`         —— 由 `isSecureRequest(req)` 动态推断，而非硬编码 true，
 *                       以便本地 HTTP 开发时仍能种上 cookie。
 *
 * 返回类型虽然声明包含 `domain`，但当前实现**从不返回该字段**（相关逻辑已注释）。
 *
 * 重要：种 cookie 与清 cookie 必须使用本函数返回的同一组属性，
 * 否则浏览器视为不同 cookie，登出会失败。
 *
 * @param req 当前 Express 请求（仅用于推断 secure）
 * @returns 可直接展开进 `res.cookie(name, value, {...opts, maxAge})` 的选项
 */
export function getSessionCookieOptions(
  req: Request
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  // ↓↓↓ 以下被注释掉的是"把 cookie 提升到父域"的逻辑：
  //   把 example.com 变成 .example.com，使 www / cdn / 轮换域名等子域共享登录态；
  //   localhost 与 IP 场景则跳过（浏览器不接受为其设置 domain）。
  //   目前禁用，cookie 为 host-only —— 换域名会丢登录态。恢复前需确认
  //   轮换域名是否为同一父域的子域，跨顶级域（如 a.com → b.com）本就无法共享。
  // const hostname = req.hostname;
  // const shouldSetDomain =
  //   hostname &&
  //   !LOCAL_HOSTS.has(hostname) &&
  //   !isIpAddress(hostname) &&
  //   hostname !== "127.0.0.1" &&
  //   hostname !== "::1";

  // const domain =
  //   shouldSetDomain && !hostname.startsWith(".")
  //     ? `.${hostname}`
  //     : shouldSetDomain
  //       ? hostname
  //       : undefined;

  return {
    httpOnly: true,
    path: "/",
    sameSite: "none",
    secure: isSecureRequest(req),
  };
}
