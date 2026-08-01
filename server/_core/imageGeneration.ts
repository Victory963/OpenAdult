/**
 * Image generation helper using internal ImageService
 *
 * Example usage:
 *   const { url: imageUrl } = await generateImage({
 *     prompt: "A serene landscape with mountains"
 *   });
 *
 * For editing:
 *   const { url: imageUrl } = await generateImage({
 *     prompt: "Add a rainbow to this landscape",
 *     originalImages: [{
 *       url: "https://example.com/original.jpg",
 *       mimeType: "image/jpeg"
 *     }]
 *   });
 *
 * ============================================================================
 * server/_core/imageGeneration.ts — AI 图像生成 / 图像编辑封装
 * ============================================================================
 *
 * 架构层级：**框架核心（`server/_core/`）— 外部服务适配层**。
 * 封装 Forge 网关的 `images.v1.ImageService/GenerateImage` RPC，并负责把生成结果
 * **落盘到 S3**，对外只暴露一个可直接用于 `<img src>` 的 URL。
 *
 * ## 主要导出
 * - `generateImage(options)` —— 文生图 / 图生图（编辑）二合一入口。
 * - `GenerateImageOptions` / `GenerateImageResponse` —— 入参与返回值类型。
 *
 * ## 上下游依赖
 * - 上游调用方：当前代码库中**暂无业务调用**（属于 Manus 模板预置能力，为后续
 *   「AI 生成封面 / 海报」等功能预留）。
 * - 下游依赖：
 *   - `./env` 的 `ENV.forgeApiUrl` / `ENV.forgeApiKey`
 *   - `server/storage` 的 `storagePut()` → S3（Backblaze B2）
 *
 * ## 关键设计决策与坑
 * 1. **协议不是 REST 而是 Connect RPC**：请求头必须带 `connect-protocol-version: 1`，
 *    路径形如 `<service>/<Method>`，与同目录下 `llm.ts` 走的 OpenAI 风格 `/v1/...` 不同。
 * 2. **返回的是 base64 而非 URL**：上游把图片内容直接内联在响应里，因此本函数必须
 *    自行转 Buffer 并上传 S3，否则数据无处存放。
 * 3. **import 路径为 `server/storage`（非相对路径）**：依赖 tsconfig 的 baseUrl/paths 解析，
 *    与本目录其他文件的 `./env` 风格不一致，属既有写法，勿改。
 * 4. **返回类型 `url` 被标注为可选（`url?`）**，但实现里 `storagePut` 成功时必然有值；
 *    调用方仍需按可选处理以满足类型检查。
 */
import { storagePut } from "server/storage";
import { ENV } from "./env";

/**
 * 图像生成入参。
 *
 * @property prompt         生成/编辑指令的自然语言描述（必填）。
 * @property originalImages 参考图列表。**留空 = 纯文生图；非空 = 图生图/编辑**。
 *                          每项可用 `url`（公网地址）或 `b64Json`（内联 base64）二选一提供，
 *                          `mimeType` 用于告知上游解码方式。
 */
export type GenerateImageOptions = {
  prompt: string;
  originalImages?: Array<{
    url?: string;
    b64Json?: string;
    mimeType?: string;
  }>;
};

/** 生成结果。`url` 是已落盘 S3 的公网可访问地址，可直接用于 `<img src={url} />`。 */
export type GenerateImageResponse = {
  url?: string;
};

/**
 * 生成或编辑一张图片，并把结果持久化到 S3。
 *
 * 权限级别：无（内部工具函数，鉴权由调用它的 tRPC procedure 负责）。
 *
 * 副作用：
 * - 出网调用 Forge 图像服务（**计费**）。
 * - **写 S3**：把生成结果存到 `generated/<时间戳>.png`。
 * - 无重试、无超时控制。
 *
 * @param options 见 `GenerateImageOptions`
 * @returns `{ url }`，指向 S3 上刚落盘的图片
 * @throws Error 当 `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY` 未配置，
 *         或上游返回非 2xx（错误信息包含状态码与响应体）时。
 *         上游响应缺少 `image.b64Json` 字段时会抛 TypeError（未做防御性校验）。
 */
export async function generateImage(
  options: GenerateImageOptions
): Promise<GenerateImageResponse> {
  if (!ENV.forgeApiUrl) {
    throw new Error("BUILT_IN_FORGE_API_URL is not configured");
  }
  if (!ENV.forgeApiKey) {
    throw new Error("BUILT_IN_FORGE_API_KEY is not configured");
  }

  // Build the full URL by appending the service path to the base URL
  // 必须先补齐末尾斜杠：`new URL(relative, base)` 在 base 不以 "/" 结尾时会把最后一段
  // 路径当作文件名替换掉，例如 base="https://x/api" 会拼成 "https://x/images.v1..."
  // 而不是 "https://x/api/images.v1..."。
  const baseUrl = ENV.forgeApiUrl.endsWith("/")
    ? ENV.forgeApiUrl
    : `${ENV.forgeApiUrl}/`;
  const fullUrl = new URL(
    "images.v1.ImageService/GenerateImage",
    baseUrl
  ).toString();

  // Connect RPC over HTTP：固定 POST + JSON，`connect-protocol-version: 1` 为协议必需头，
  // 缺失会被网关以协议错误拒绝。请求体字段用 snake_case（`original_images`）以匹配 protobuf 定义。
  const response = await fetch(fullUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${ENV.forgeApiKey}`,
    },
    body: JSON.stringify({
      prompt: options.prompt,
      // 未传参考图时发空数组而非 undefined —— protobuf 侧期望字段存在。
      original_images: options.originalImages || [],
    }),
  });

  if (!response.ok) {
    // `.catch(() => "")`：读取响应体本身也可能失败（连接已断），此时降级为空 detail，
    // 保证抛出的仍是那条带状态码的可读错误，而不是被读取异常掩盖。
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Image generation request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
    );
  }

  // 上游把图片内容以 base64 内联返回（不给 URL），因此必须在此解码并自行持久化。
  const result = (await response.json()) as {
    image: {
      b64Json: string;
      mimeType: string;
    };
  };
  const base64Data = result.image.b64Json;
  const buffer = Buffer.from(base64Data, "base64");

  // Save to S3
  // Key 用毫秒时间戳保证唯一。⚠️ 两处不一致是已知瑕疵：
  // 1) 扩展名硬编码 `.png`，而实际 Content-Type 取自上游的 `mimeType`（可能是 jpeg/webp）；
  // 2) 高并发下同一毫秒内的两次生成会撞 key，后者覆盖前者。
  const { url } = await storagePut(
    `generated/${Date.now()}.png`,
    buffer,
    result.image.mimeType
  );
  return {
    url,
  };
}
