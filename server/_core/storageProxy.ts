/**
 * S3 对象存储代理 (framework core / 传输层)
 * ============================================================================
 * 架构定位
 * --------
 * `server/_core/` 下的原始 Express 路由，把所有 `/manus-storage/<key>` 形式的
 * 内部路径转换成对 Forge Storage 后端的访问。数据库里存的媒体地址（
 * `videos.videoUrl`、`actresses.imageUrl` 等）一律是这种相对路径 —— 好处是
 * **presigned URL 会过期，而数据库里的值必须永久有效**，因此落库的是稳定的
 * 逻辑路径，签名在每次请求时现取。
 *
 * 主要导出物
 * ----------
 * - `registerStorageProxy(app)` —— 注册 `GET /manus-storage/*`
 *
 * 上下游依赖
 * ----------
 * 上游：`server/_core/index.ts` 注册；前端 <img> / <video> 与
 *       `hlsRoutes.ts`、`videoStream.ts` 的重定向目标都会打到这里。
 * 下游：Forge Storage API (`v1/storage/downloadUrl`) → 实际的 S3/B2 对象。
 *
 * 关键设计决策与坑
 * ----------------
 * 1. **视频代理、其他重定向**：视频必须由 Node 代理转发，原因有二 ——
 *    (a) 需要保证 `Accept-Ranges`/`Content-Range` 语义正确，播放器才能 seek；
 *    (b) 需要把 S3 上的 `application/octet-stream` 改写成 `video/mp4`，
 *        否则浏览器不解码。图片等静态资源没有这些问题，直接 307 甩给 S3
 *        以节省服务器带宽。
 * 2. 每次请求都要向 Forge 换一次签名 URL（无缓存），是一次额外的 RTT。
 * 3. 该端点无鉴权（媒体资源需要能被 <img>/<video> 直接加载）。
 * ============================================================================
 */
import type { Express } from "express";
import { ENV } from "./env";

// Map file extensions to MIME types
// 只白名单本站会用到的类型；未列出的类型走「重定向」分支，由 S3 自己决定
// Content-Type，避免我们错误声明导致浏览器解析失败。
const MIME_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

/**
 * 从存储键推断应该声明的 MIME 类型。
 *
 * 两级推断策略（因为分片上传写进 S3 的对象**没有扩展名**）：
 *   1) 优先看扩展名，命中白名单直接返回；
 *   2) 无扩展名时按路径约定兜底：
 *      - `videos/` 目录或 `chunk-` 前缀 → 视频分片（fastUpload 写入时
 *        统一用 `application/octet-stream`，这里必须纠正为 video/mp4）
 *      - `thumbnails/` 目录 → 封面图
 *
 * @param key 存储键，如 `videos/42/abc/chunk-0` 或 `uploads/1/a.png`
 * @returns MIME 字符串；无法判断时返回 null（调用方将走「重定向」分支）
 * 副作用：无
 */
function getMimeType(key: string): string | null {
  // Check if the key has a recognizable extension
  const parts = key.split(".");
  if (parts.length > 1) {
    const ext = parts.pop()!.toLowerCase();
    return MIME_TYPES[ext] || null;
  }
  // Check if the key path contains video-related patterns
  if (key.includes("videos/") || key.includes("chunk-")) {
    return "video/mp4";
  }
  if (key.includes("thumbnails/")) {
    return "image/jpeg";
  }
  return null;
}

/**
 * 在 Express 应用上注册对象存储代理路由。
 * 由 `server/_core/index.ts` 启动时调用一次。
 *
 * 注册的端点：`GET /manus-storage/*`
 *   - 权限级别：public（媒体资源必须能被 <img>/<video> 裸加载）
 *   - 通配符捕获组 `*` 即完整的 S3 对象键（可含多级 `/`）
 *   - 视频类：代理转发字节流，透传 Range，改写 Content-Type
 *   - 非视频类：307 重定向到 presigned URL，带宽由 S3/CDN 承担
 *   - 返回码：400 缺 key / 500 未配置 Forge / 502 后端或上游异常
 *
 * @param app Express 实例
 * 副作用：注册路由；每次请求会调用 Forge Storage API 换签名 URL
 */
export function registerStorageProxy(app: Express) {
  app.get("/manus-storage/*", async (req, res) => {
    // Express 4 的通配符路由把 `*` 匹配到的整段路径放在 params[0]，
    // 例如 /manus-storage/videos/1/abc/chunk-0 → key = "videos/1/abc/chunk-0"
    const key = (req.params as Record<string, string>)[0];
    if (!key) {
      res.status(400).send("Missing storage key");
      return;
    }

    // 缺少 Forge 配置时立刻 500，而不是让后面的 fetch 抛出难以定位的错误
    if (!ENV.forgeApiUrl || !ENV.forgeApiKey) {
      res.status(500).send("Storage proxy not configured");
      return;
    }

    try {
      // 归一化 base 的尾部斜杠：new URL("v1/x", "https://a/b") 会解析成
      // "https://a/v1/x"（丢掉 b 段），补上尾斜杠才能得到 "https://a/b/v1/x"
      const forgeUrl = new URL(
        "v1/storage/downloadUrl",
        ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
      );
      forgeUrl.searchParams.set("path", key);

      const forgeResp = await fetch(forgeUrl, {
        headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
      });

      if (!forgeResp.ok) {
        // 读取错误体仅用于日志排查；.catch 兜底防止读 body 本身再抛异常。
        // 对外统一返回 502（Bad Gateway）——错误来自上游存储服务而非本服务。
        const body = await forgeResp.text().catch(() => "");
        console.error(`[StorageProxy] forge error: ${forgeResp.status} ${body}`);
        res.status(502).send("Storage backend error");
        return;
      }

      const { url } = (await forgeResp.json()) as { url: string };
      if (!url) {
        res.status(502).send("Empty signed URL from backend");
        return;
      }

      // Determine content type
      const mimeType = getMimeType(key);

      // For video files, proxy the content with correct headers to support Range requests
      // 视频走「代理」而非「重定向」的两个硬性理由见文件头说明：
      // 需要保证 Range/seek 语义，且要把 octet-stream 改写成正确的 video/* 类型。
      if (mimeType && mimeType.startsWith("video/")) {
        // 原样透传客户端的 Range 头，让 S3 直接返回请求区间，
        // Node 只做管道不做区间计算（与 videoStream.ts 的跨分片拼接不同）。
        const rangeHeader = req.headers.range;
        const fetchHeaders: Record<string, string> = {};
        if (rangeHeader) {
          fetchHeaders["Range"] = rangeHeader;
        }

        const upstream = await fetch(url, { headers: fetchHeaders });

        // 206 是 Range 请求的正常成功码，但 fetch 的 `ok` 只覆盖 200-299 中的语义判断，
        // 这里显式放行 206 以免被当成错误。
        if (!upstream.ok && upstream.status !== 206) {
          console.error(`[StorageProxy] upstream error: ${upstream.status}`);
          res.status(502).send("Upstream error");
          return;
        }

        // Set response headers
        // 状态码原样透传（200 或 206）；Content-Type 用我们推断的值覆盖上游，
        // Accept-Ranges 声明可 seek，Content-Length/Range 则必须忠实转发，
        // 否则播放器算不出总时长与可拖动范围。
        res.status(upstream.status);
        res.set("Content-Type", mimeType);
        res.set("Accept-Ranges", "bytes");

        const contentLength = upstream.headers.get("content-length");
        if (contentLength) res.set("Content-Length", contentLength);

        const contentRange = upstream.headers.get("content-range");
        if (contentRange) res.set("Content-Range", contentRange);

        // 1 小时：媒体对象内容不可变，但底层 presigned URL 有有效期，
        // 缓存过久会导致签名失效后仍被引用。
        res.set("Cache-Control", "public, max-age=3600");

        // Stream the response
        // 用 pump() 逐块搬运，避免把整个视频读进内存。
        // 循环里每次都检查 res.writableEnded：客户端 seek/关页会中断连接，
        // 此时继续 write 会抛 ERR_STREAM_WRITE_AFTER_END。
        if (upstream.body) {
          const reader = upstream.body.getReader();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!res.writableEnded) {
                res.write(value);
              } else {
                break;
              }
            }
            if (!res.writableEnded) {
              res.end();
            }
          };
          // pump 是异步的且**不被 await** —— 处理函数会先返回，由 pump 自行收尾。
          // 因此必须挂 .catch：否则流中途出错会变成 unhandled rejection。
          // 此时 header 早已发出，无法再改状态码，只能静默结束连接。
          pump().catch((err) => {
            console.error("[StorageProxy] stream error:", err);
            if (!res.writableEnded) res.end();
          });
        } else {
          res.end();
        }
      } else {
        // For non-video files, redirect with proper cache headers
        // 图片/PDF 等静态资源无需代理：307 让浏览器直连 S3，服务器零带宽消耗。
        // 用 307 而非 302 是为了保留原始请求方法与语义（且明确表示「临时」，
        // 浏览器不会把这个跳转永久缓存下来——presigned URL 会过期）。
        res.set("Cache-Control", "public, max-age=3600");
        res.redirect(307, url);
      }
    } catch (err) {
      // 网络异常 / JSON 解析失败等：一律 502，错误细节只进服务端日志
      console.error("[StorageProxy] failed:", err);
      res.status(502).send("Storage proxy error");
    }
  });
}
