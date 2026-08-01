/**
 * ============================================================================
 * server/_core/notification.ts — 站点所有者通知下发
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 封装 Manus 通知服务（Forge 网关的
 * `webdevtoken.v1.WebDevService/SendNotification` RPC），用于把运营/告警消息
 * 推送给**项目所有者**（收件人由网关根据 API Key 归属自动解析，本地不指定收件人）。
 *
 * ## 主要导出
 * - `notifyOwner(payload)` —— 发送一条通知，返回是否被上游受理。
 * - `NotificationPayload` —— `{ title, content }`。
 *
 * ## 上下游依赖
 * - 上游调用方：`server/_core/systemRouter.ts`（系统路由中的通知 procedure）。
 * - 下游依赖：`./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey`。
 *   （注：收件人对应 `ENV.ownerOpenId`，但本文件并不显式传它，由网关侧解析。）
 *
 * ## 关键设计决策与坑
 * **错误处理刻意分成两类**，这是本文件最重要的约定：
 * - **调用方能修的问题 → 抛 `TRPCError`**：标题/正文为空、超长、服务未配置。
 *   这些是编程或部署错误，应该让请求失败并暴露出来。
 * - **上游不可达 → 返回 `false`，不抛**：网络异常、上游 5xx。通知属于旁路能力，
 *   不应因为通知发不出去就让主业务流程失败；调用方可据此降级到邮件/Slack。
 *
 * 另外：**无重试、无队列**。一次 fetch 失败即视为失败，消息会丢失，不适合承载
 * 必达语义的业务通知。
 */
import { TRPCError } from "@trpc/server";
import { ENV } from "./env";

/**
 * 通知内容。两个字段都必填且不能是纯空白字符。
 * @property title   通知标题，trim 后不超过 `TITLE_MAX_LENGTH`
 * @property content 通知正文，trim 后不超过 `CONTENT_MAX_LENGTH`
 */
export type NotificationPayload = {
  title: string;
  content: string;
};

// 长度上限来自 Manus 通知服务的服务端约束，在本地先行校验是为了把错误提前到
// 请求发出之前，给出比上游 400 更明确的报错信息。
const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

const trimValue = (value: string): string => value.trim();
/** 类型守卫：非 null 且 trim 后非空的字符串。用于拦截 `"   "` 这类"看起来有值"的输入。 */
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * 拼接 SendNotification 端点地址。
 * 补齐末尾斜杠是必需的 —— `new URL(relative, base)` 在 base 不以 "/" 结尾时
 * 会替换掉 base 的最后一段路径。
 */
const buildEndpointUrl = (baseUrl: string): string => {
  const normalizedBase = baseUrl.endsWith("/")
    ? baseUrl
    : `${baseUrl}/`;
  return new URL(
    "webdevtoken.v1.WebDevService/SendNotification",
    normalizedBase
  ).toString();
};

/**
 * 校验并规范化通知内容。
 *
 * 注意校验顺序：**先判非空、再 trim、最后判长度**。长度检查针对的是 trim 之后的
 * 字符串，因此首尾空白不计入配额。
 *
 * @param input 原始入参
 * @returns 已 trim 的 `{ title, content }`
 * @throws TRPCError(BAD_REQUEST) 标题/正文为空或超长时
 */
const validatePayload = (input: NotificationPayload): NotificationPayload => {
  if (!isNonEmptyString(input.title)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification title is required.",
    });
  }
  if (!isNonEmptyString(input.content)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Notification content is required.",
    });
  }

  const title = trimValue(input.title);
  const content = trimValue(input.content);

  if (title.length > TITLE_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification title must be at most ${TITLE_MAX_LENGTH} characters.`,
    });
  }

  if (content.length > CONTENT_MAX_LENGTH) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Notification content must be at most ${CONTENT_MAX_LENGTH} characters.`,
    });
  }

  return { title, content };
};

/**
 * Dispatches a project-owner notification through the Manus Notification Service.
 * Returns `true` if the request was accepted, `false` when the upstream service
 * cannot be reached (callers can fall back to email/slack). Validation errors
 * bubble up as TRPC errors so callers can fix the payload.
 *
 * 向站点所有者推送一条通知。
 *
 * 权限级别：无（内部工具函数）。实际调用点在 `systemRouter.ts` 中，鉴权由那里的
 * tRPC procedure 决定。
 *
 * 副作用：一次出网 HTTP POST 到 Forge 网关；上游失败时写 `console.warn` 日志。
 * 不写库、不写 S3、无重试。
 *
 * **返回值 vs 抛异常的分工**（重要）：
 * - `true`  —— 上游返回 2xx，通知已被受理（注意：受理 ≠ 用户已收到）。
 * - `false` —— 上游不可达或返回非 2xx。**不抛异常**，让调用方自行决定是否降级
 *              到邮件 / Slack 等其他渠道。
 * - 抛异常 —— 仅限"调用方能修的问题"：入参非法、服务未配置。
 *
 * @param payload 见 `NotificationPayload`
 * @returns 是否被上游受理
 * @throws TRPCError(BAD_REQUEST)           title/content 为空或超长
 * @throws TRPCError(INTERNAL_SERVER_ERROR) `BUILT_IN_FORGE_API_URL` 或
 *                                          `BUILT_IN_FORGE_API_KEY` 未配置
 */
export async function notifyOwner(
  payload: NotificationPayload
): Promise<boolean> {
  // 先校验再看配置：入参错误比配置缺失更"贴近调用方"，优先报出更有用的那个。
  const { title, content } = validatePayload(payload);

  if (!ENV.forgeApiUrl) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service URL is not configured.",
    });
  }

  if (!ENV.forgeApiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Notification service API key is not configured.",
    });
  }

  const endpoint = buildEndpointUrl(ENV.forgeApiUrl);

  // try 覆盖整个网络交互：从这里开始的一切失败都降级为返回 false（旁路能力不阻塞主流程）。
  try {
    // Connect RPC 协议：`connect-protocol-version: 1` 为必需头，缺失会被网关拒绝。
    // 请求体不含收件人 —— 由网关根据 API Key 归属解析为项目所有者。
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${ENV.forgeApiKey}`,
        "content-type": "application/json",
        "connect-protocol-version": "1",
      },
      body: JSON.stringify({ title, content }),
    });

    // 非 2xx：记 warn 日志（保留状态码与响应体便于排查）后返回 false，不抛。
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(
        `[Notification] Failed to notify owner (${response.status} ${response.statusText})${
          detail ? `: ${detail}` : ""
        }`
      );
      return false;
    }

    return true;
  } catch (error) {
    // 网络层异常（DNS 失败、连接被拒、超时）同样降级为 false。
    console.warn("[Notification] Error calling notification service:", error);
    return false;
  }
}
