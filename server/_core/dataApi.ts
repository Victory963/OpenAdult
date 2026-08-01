/**
 * Quick example (matches curl usage):
 *   await callDataApi("Youtube/search", {
 *     query: { gl: "US", hl: "en", q: "manus" },
 *   })
 *
 * ============================================================================
 * server/_core/dataApi.ts — 第三方数据 API 统一代理网关
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 把「调用各类第三方 API」这件事收敛到 Forge 网关的单个 RPC
 * (`webdevtoken.v1.WebDevService/CallApi`) 上：本项目不持有任何第三方厂商的
 * API Key，只持有 Forge 的 key，由网关代持凭据并转发。
 *
 * ## 主要导出
 * - `callDataApi(apiId, options)` —— 通用代理调用入口。
 * - `DataApiCallOptions` —— 四类参数载体（query / body / pathParams / formData）。
 *
 * ## 上下游依赖
 * - 上游调用方：当前代码库中**暂无业务调用**（Manus 模板预置能力）。
 * - 下游依赖：`./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey`。
 *
 * ## 关键设计决策与坑
 * 1. **返回类型是 `unknown`**：因为不同 `apiId` 的响应结构完全不同，无法给出统一类型。
 *    调用方必须自行断言或用 zod 校验后再使用。
 * 2. **双层信封（envelope）**：网关把真实响应塞在 `payload.jsonData` 这个**字符串**字段里，
 *    需要二次 `JSON.parse` 才能拿到业务数据 —— 见函数末尾的解包逻辑。
 * 3. **协议为 Connect RPC**：必须带 `connect-protocol-version: 1` 头。
 * 4. 无重试、无超时、无缓存。
 */
import { ENV } from "./env";

/**
 * 代理调用的参数载体。四类参数会**原样打包**进 RPC 请求体，由网关按目标 API 的
 * 定义分发到相应位置（URL query / JSON body / 路径占位符 / multipart 表单）。
 * 全部可选，按目标 API 的实际需要选填。
 *
 * @property query      URL 查询参数，如 `{ q: "manus", hl: "en" }`
 * @property body       JSON 请求体
 * @property pathParams 路径占位符替换值（会被转成 snake_case 的 `path_params` 发出）
 * @property formData   multipart 表单字段（发出时字段名为 `multipart_form_data`）
 */
export type DataApiCallOptions = {
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  pathParams?: Record<string, unknown>;
  formData?: Record<string, unknown>;
};

/**
 * 通过 Forge 网关调用一个第三方数据 API。
 *
 * 权限级别：无（内部工具函数，鉴权由调用它的 tRPC procedure 负责）。
 *
 * 副作用：一次出网 HTTP POST 到 Forge 网关（**可能计费**）。不写库、不写 S3。
 *
 * @param apiId   目标 API 标识，形如 `"Youtube/search"`，由 Forge 侧的 API 目录定义
 * @param options 见 `DataApiCallOptions`，默认为空对象（即无参调用）
 * @returns 解包后的业务响应体。由于结构随 `apiId` 变化，类型为 `unknown`，
 *          调用方需自行收窄
 * @throws Error 当 `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY` 未配置，
 *         或网关返回非 2xx 时（错误信息含状态码与响应体）
 */
export async function callDataApi(
  apiId: string,
  options: DataApiCallOptions = {}
): Promise<unknown> {
  if (!ENV.forgeApiUrl) {
    throw new Error("BUILT_IN_FORGE_API_URL is not configured");
  }
  if (!ENV.forgeApiKey) {
    throw new Error("BUILT_IN_FORGE_API_KEY is not configured");
  }

  // Build the full URL by appending the service path to the base URL
  // 补齐末尾斜杠是必需的：`new URL(relative, base)` 在 base 不以 "/" 结尾时，
  // 会把 base 的最后一段路径当文件名替换掉，导致拼出错误的端点。
  const baseUrl = ENV.forgeApiUrl.endsWith("/") ? ENV.forgeApiUrl : `${ENV.forgeApiUrl}/`;
  const fullUrl = new URL("webdevtoken.v1.WebDevService/CallApi", baseUrl).toString();

  const response = await fetch(fullUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${ENV.forgeApiKey}`,
    },
    // 字段命名混用是刻意的：`apiId` / `query` / `body` 沿用 camelCase，
    // 而 `path_params` / `multipart_form_data` 必须用 snake_case —— 以网关侧的
    // protobuf 定义为准，勿"统一风格"。未传的字段值为 undefined，会被
    // JSON.stringify 自动省略。
    body: JSON.stringify({
      apiId,
      query: options.query,
      body: options.body,
      path_params: options.pathParams,
      multipart_form_data: options.formData,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Data API request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
    );
  }

  // ---- 解包双层信封 ----
  // 网关的响应结构是 { jsonData: "<真实响应的 JSON 字符串>" }，即业务数据被
  // 二次字符串化后塞进一个字段。这里逐层剥离，并对每一层都做降级：
  //   1) 响应体本身不是合法 JSON      → 降级为 {}（不抛错，让调用方拿到空对象）
  //   2) 没有 jsonData 字段           → 说明不是信封格式，原样返回整个 payload
  //   3) jsonData 存在但不是合法 JSON → 原样返回该字符串，交给调用方处理
  //      （典型场景：目标 API 返回的是纯文本/HTML 而非 JSON）
  //   4) jsonData 为 null/undefined   → 用 "{}" 兜底，parse 出空对象
  const payload = await response.json().catch(() => ({}));
  if (payload && typeof payload === "object" && "jsonData" in payload) {
    try {
      return JSON.parse((payload as Record<string, string>).jsonData ?? "{}");
    } catch {
      return (payload as Record<string, unknown>).jsonData;
    }
  }
  return payload;
}
