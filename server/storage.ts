/**
 * server/storage.ts — 对象存储访问层 (S3 兼容存储的薄封装)
 *
 * 【架构定位】
 * 本文件不直接使用 AWS SDK 连接 S3/Backblaze B2，而是通过 Manus 平台提供的
 * **Storage Proxy (Forge API)** 间接读写对象。所有请求带 `Authorization: Bearer <apiKey>`，
 * 由代理侧完成真正的 S3 鉴权与桶路由。好处是应用容器里不需要保存 AWS 密钥；
 * 代价是多了一跳网络，且上传走的是 multipart/form-data 而非 S3 原生协议。
 *
 * 【主要导出物】
 *   - storagePut(relKey, data, contentType) : 上传对象，返回 { key, 可直接访问的 url }
 *   - storageGet(relKey)                    : 换取该对象的下载 URL (presigned URL)
 *
 * 【上下游依赖】
 *   上游 (调用方)：
 *     - server/file-upload.ts               (用户图片上传)
 *     - server/routers/video-upload.ts      (视频整体上传 V1)
 *     - server/routers/video-upload-v2.ts   (分片上传：分片落盘 → 合并 → 缩略图)
 *     - server/_core/fastUpload.ts          (快速二进制分片上传)
 *     - server/_core/hlsRoutes.ts           (HLS m3u8 / ts 分片取下载地址)
 *     - server/_core/imageGeneration.ts     (AI 生成图落盘)
 *   下游 (被依赖)：./_core/env 的 forgeApiUrl / forgeApiKey，以及全局 fetch/FormData/Blob
 *                  (依赖 Node 18+ 的 undici 实现)。
 *
 * 【关键设计决策 / 坑】
 *   1. **key 是相对路径**：所有对外 API 都接受「相对 key」(如 `uploads/1/a.png`)，
 *      内部统一用 normalizeKey 去掉前导斜杠，避免代理侧把 `/a.png` 解析成桶根路径。
 *   2. **URL 是临时的**：storageGet 返回的是代理签发的下载 URL，通常带有效期。
 *      不要把它长期存进数据库当作永久地址——数据库里应存 key，展示时再换取 URL。
 *   3. **没有分片/流式上传**：storagePut 一次性把整个 Buffer 包成 Blob 发出去，
 *      大文件必须由调用方 (video-upload-v2 / fastUpload) 自行切片。
 */

// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { ENV } from './_core/env';

/** 存储代理的连接配置：基础 URL + Bearer Token。 */
type StorageConfig = { baseUrl: string; apiKey: string };

/**
 * 读取并校验存储代理配置。
 *
 * 每次调用都重新从 ENV 读取 (不做缓存)，因此环境变量在运行期被替换后能立即生效。
 * 结尾的 `replace(/\/+$/, "")` 去掉 baseUrl 末尾的一个或多个斜杠，
 * 与后面 `ensureTrailingSlash` 配合，保证无论用户怎么填 BUILT_IN_FORGE_API_URL
 * (带不带斜杠) 拼出来的路径都一致。
 *
 * @returns 规范化后的 { baseUrl, apiKey }
 * @throws 当 BUILT_IN_FORGE_API_URL 或 BUILT_IN_FORGE_API_KEY 缺失时抛错 —
 *         这是 fail-fast 设计：存储没配好时上传应立刻报错，而不是静默丢文件。
 */
function getStorageConfig(): StorageConfig {
  const baseUrl = ENV.forgeApiUrl;
  const apiKey = ENV.forgeApiKey;

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

/**
 * 拼出上传端点 `{baseUrl}/v1/storage/upload?path={key}`。
 *
 * 用相对路径 "v1/storage/upload" + 带尾斜杠的 base 构造 URL：
 * 若 base 不带尾斜杠，`new URL()` 会把 base 的最后一段路径当作文件名替换掉
 * (例如 `https://api.x/forge` + `v1/...` → `https://api.x/v1/...`)，
 * 因此 ensureTrailingSlash 是必需的，不能省。
 *
 * @param baseUrl 已去掉尾斜杠的代理基础 URL
 * @param relKey  对象相对 key
 * @returns 可直接 fetch 的 URL 对象
 */
function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

/**
 * 向代理换取某个对象的下载地址 (presigned URL)。
 *
 * 这是一次额外的往返请求：代理返回 `{ url: "..." }`，其中的 URL 通常是
 * S3 侧签名过、有有效期的直链，客户端可以绕过本服务直接下载。
 * HLS 播放路径 (server/_core/hlsRoutes.ts) 高频调用本函数换取分片地址。
 *
 * @param baseUrl 代理基础 URL
 * @param relKey  对象相对 key
 * @param apiKey  Bearer Token
 * @returns 下载 URL 字符串 (保证是非空字符串)
 * @throws HTTP 非 2xx 时抛出包含状态码与响应体的 Error (与 storagePut 的错误路径一致)；
 *         响应体不是合法 JSON、或 JSON 中缺少 `url` 字段时同样抛错，
 *         避免把 undefined 传给调用方 (如 hlsRoutes 会拿它去 fetch)。
 */
async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });

  // 修复：补上此前遗漏的 `response.ok` 校验。
  // 代理返回 4xx/5xx 时，响应体可能是 JSON 错误对象 (解析后没有 url → 返回 undefined)，
  // 也可能是网关的 HTML/纯文本 (直接抛 "Unexpected token" 之类的解析异常)。
  // 两种情况都会把真实原因掩盖掉，因此改为与 storagePut 相同的 fail-fast 错误路径。
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage downloadUrl failed (${response.status} ${response.statusText}): ${message}`
    );
  }

  // 修复：即使 HTTP 200，也可能因代理协议变更而缺少 url 字段；
  // 此处显式校验，保证函数的返回值真的满足 Promise<string> 契约。
  const payload = (await response.json().catch(() => null)) as
    | { url?: unknown }
    | null;
  const url = payload?.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      `Storage downloadUrl returned no url for key "${normalizeKey(relKey)}"`
    );
  }
  return url;
}

/** 保证 URL 以 `/` 结尾，供 `new URL(relative, base)` 正确拼接子路径。 */
function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

/**
 * 规范化对象 key：去掉所有前导斜杠。
 * 代理侧的 path 参数按「桶内相对路径」解析，`/foo.png` 与 `foo.png` 会被视作不同对象，
 * 统一去掉前导斜杠可避免同一文件产生两个 key。
 */
function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

/**
 * 把待上传数据包装成 multipart/form-data。
 *
 * 字符串走 `new Blob([string])` 会按 UTF-8 编码；Buffer/Uint8Array 则按原始字节。
 * `data as any` 是为了绕过 TS 对 BlobPart 的类型收窄 (Node 的 Buffer 在类型上
 * 不完全匹配 DOM 的 BufferSource 定义)，运行时是合法的。
 *
 * @param data        文件内容
 * @param contentType MIME 类型，同时写进 Blob 的 type
 * @param fileName    表单里的文件名；为空时回退成字面量 "file"
 * @returns 可直接作为 fetch body 的 FormData (fetch 会自动补 boundary 头)
 */
function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([data as any], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}

/** 构造代理鉴权头。注意：**不要**手工设置 Content-Type，否则 FormData 的 boundary 会丢失。 */
function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * 上传对象到存储代理。
 *
 * 表单里的文件名取 key 的最后一段 (`a/b/c.mp4` → `c.mp4`)；若 key 不含斜杠则用完整 key。
 * 真正决定对象位置的是 query 里的 `path`，文件名只是给代理侧留的元信息。
 *
 * @param relKey      对象相对 key，例如 `videos/2026/xxx.mp4`；前导斜杠会被自动去掉
 * @param data        文件内容 (Buffer / Uint8Array / 字符串)
 * @param contentType MIME 类型，默认 `application/octet-stream`
 *                    (分片上传的中间分片故意用这个默认值，因为分片本身不是完整媒体文件)
 * @returns `{ key, url }`：key 为规范化后的存储键，url 为可直接在前端使用的访问地址
 * @throws 配置缺失时抛错 (见 getStorageConfig)；
 *         HTTP 非 2xx 时抛出包含状态码与响应体的 Error，方便定位代理侧问题
 *
 * 副作用：写 S3 兼容存储 (一次网络往返，无重试)。
 *
 * 注意：整个文件在内存中转成 Blob，内存占用约等于文件大小；
 * 大视频请使用分片上传路径 (server/routers/video-upload-v2.ts)。
 */
export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  // 错误路径：先尝试读响应体拿到代理返回的详细原因；
  // 读取失败 (例如响应体已被消费或流中断) 时退回到 statusText，保证不会因为
  // 「构造错误信息」本身再抛一个二次异常而掩盖真正的失败原因。
  if (!response.ok) {
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
  }
  const url = (await response.json()).url;
  return { key, url };
}

/**
 * 获取已存在对象的下载地址。
 *
 * 与 storagePut 不同，本函数**不校验对象是否存在**——代理对不存在的 key
 * 可能仍返回一个签名 URL，实际访问时才 404。调用方 (如 HLS 路由) 需要自行处理。
 *
 * @param relKey 对象相对 key
 * @returns `{ key, url }`：url 为临时下载地址 (保证是非空字符串)，不应持久化存储
 * @throws 配置缺失时抛错；代理返回非 2xx 或响应体缺少 url 字段时抛出带状态码/原因的
 *         Error (见 buildDownloadUrl)，调用方应自行 try/catch 降级
 *
 * 副作用：一次到存储代理的网络请求 (只读，不修改对象)。
 */
export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}
