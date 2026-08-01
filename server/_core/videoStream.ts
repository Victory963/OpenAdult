/**
 * 分片视频流式播放路由 (framework core / 传输层)
 * ============================================================================
 * 架构定位
 * --------
 * `server/_core/` 下的原始 Express 路由，绕过 tRPC —— 因为 <video> 元素只会发普通
 * HTTP GET 并依赖 `Range` / `206 Partial Content` 语义，tRPC 的 JSON-RPC 无法承载。
 *
 * 解决的问题
 * ----------
 * 大文件上传走的是分片通道（见 `server/_core/fastUpload.ts` 与
 * `server/routers/video-upload-v2.ts`），每个分片作为独立对象存进 S3，**从未被合并**
 * 成一个完整 MP4。于是数据库 `videos.videoUrl` 里存的是一个哨兵值
 * `multi-chunk:<sessionId>`，播放时必须由本模块把 N 个分片**在响应流中虚拟拼接**
 * 回一个连续的字节序列，让浏览器以为自己在下载单个 MP4。
 *
 * 主要导出物
 * ----------
 * - `registerVideoStream(app)` —— 在 Express app 上注册两个端点：
 *     * `GET /api/video-stream/:videoId`    完整播放（支持 Range，跨分片拼接）
 *     * `GET /api/video-thumbnail/:videoId` 只代理首个分片，供前端抓首帧做封面
 *
 * 上下游依赖
 * ----------
 * 上游：`server/_core/index.ts` 调用注册；浏览器 <video> / hls.js 直接请求；
 *       `hlsRoutes.ts` 在视频缺少 duration 时会 302 回退到本模块的 video-stream。
 * 下游：Forge Storage API（换取 presigned 下载地址）、videos / video_upload_chunks 表。
 *
 * 关键设计决策与坑
 * ----------------
 * 1. 单文件视频走 307 重定向（把带宽甩给 S3/CDN）；只有 multi-chunk 才由 Node 代理。
 * 2. 307 而非 302：307 保证浏览器不把方法改成 GET 之外的形式、且语义上是「临时」，
 *    对 Range 请求的转发行为更可预期。
 * 3. 每个分片都要单独换一次 presigned URL，无本地缓存 —— 大 Range 跨多分片时会串行
 *    发起多次 Forge API 调用，是当前的主要延迟来源。
 * ============================================================================
 */
import type { Express, Request, Response } from "express";
import { ENV } from "./env";
import { getDb } from "../db";
import { videoUploadChunks, videos } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * Video streaming endpoint for multi-chunk videos.
 * For multi-chunk videos, redirects to the first chunk for preview/thumbnail,
 * or streams chunks sequentially for full playback.
 */

/**
 * 向 Forge Storage API 换取某个对象的带签名临时下载地址。
 *
 * @param key S3 对象键（如 `videos/<userId>/<sessionId>/chunk-3`）
 * @returns   presigned URL 字符串，可直接 fetch，有效期由 Forge 侧决定
 * @throws    Forge 返回非 2xx 时抛 Error（含状态码），由各端点的 try/catch 兜底
 * 副作用：一次外部 HTTP 请求（无重试、无缓存）
 *
 * 说明：`ENV.forgeApiUrl.replace(/\/+$/, "") + "/"` 是为了让 URL 构造器正确解析
 * 相对路径 —— 若 base 末尾没有斜杠，`new URL("v1/x", "https://a/b")` 会得到
 * `https://a/v1/x`（丢掉 b 段），先归一化尾斜杠可避免这个经典陷阱。
 */
async function getSignedUrl(key: string): Promise<string> {
  const forgeUrl = new URL(
    "v1/storage/downloadUrl",
    ENV.forgeApiUrl.replace(/\/+$/, "") + "/",
  );
  forgeUrl.searchParams.set("path", key);

  const resp = await fetch(forgeUrl, {
    headers: { Authorization: `Bearer ${ENV.forgeApiKey}` },
  });

  if (!resp.ok) {
    throw new Error(`Failed to get signed URL for ${key}: ${resp.status}`);
  }

  const { url } = (await resp.json()) as { url: string };
  return url;
}

/**
 * 在 Express 应用上注册视频流相关的原始路由。
 *
 * 由 `server/_core/index.ts` 在服务器启动时调用一次。
 *
 * @param app Express 实例
 * 副作用：注册 `/api/video-stream/:videoId` 与 `/api/video-thumbnail/:videoId`
 * 权限级别：两个端点均为 public（<video> 标签无法携带鉴权 header）
 */
export function registerVideoStream(app: Express) {
  /**
   * GET /api/video-stream/:videoId
   * 分片视频的虚拟拼接播放端点。
   *
   * 行为分两种：
   *  - 普通单文件视频：307 重定向到 videoUrl（通常是 /manus-storage/... 由
   *    storageProxy 接管），Node 不承担带宽；
   *  - multi-chunk 视频：按 Range 请求计算出需要哪几个分片的哪些字节，
   *    依次从 S3 拉取并写进同一个响应流，对客户端表现为一个连续 MP4。
   *
   * @param req.params.videoId 数字视频 ID，非法则 400
   * @param req.headers.range  可选，形如 `bytes=1000-` 或 `bytes=1000-2000`
   * @returns 200（整体）/ 206（部分）/ 307（单文件重定向）/ 404 / 500
   * 副作用：读 videos + video_upload_chunks 表；对每个涉及的分片调用一次
   *         Forge presign API 并 fetch 其内容
   */
  // Endpoint: /api/video-stream/:videoId
  // For multi-chunk videos, this streams the video by fetching chunks sequentially
  app.get("/api/video-stream/:videoId", async (req: Request, res: Response) => {
    const videoId = parseInt(req.params.videoId);
    if (isNaN(videoId)) {
      res.status(400).send("Invalid video ID");
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res.status(500).send("Database not available");
        return;
      }

      // Get video record
      const videoRecords = await db
        .select()
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);

      if (videoRecords.length === 0) {
        res.status(404).send("Video not found");
        return;
      }

      const video = videoRecords[0];
      const videoUrl = video.videoUrl;

      // If videoUrl points to a single file, redirect to storageProxy
      // 普通视频不需要拼接，直接把客户端甩给 storageProxy / 外链，Node 只做一次跳转。
      if (videoUrl && !videoUrl.startsWith("multi-chunk:")) {
        res.redirect(307, videoUrl);
        return;
      }

      // Multi-chunk video: extract session ID from videoUrl
      // `multi-chunk:<sessionId>` 是上传流程写进 videos.videoUrl 的哨兵值，
      // sessionId 即 video_upload_sessions 主键，用它反查所有分片。
      const sessionId = videoUrl?.replace("multi-chunk:", "") || "";
      if (!sessionId) {
        res.status(404).send("Video source not found");
        return;
      }

      // Get all chunks for this session
      const chunks = await db
        .select()
        .from(videoUploadChunks)
        .where(eq(videoUploadChunks.sessionId, sessionId));

      if (chunks.length === 0) {
        res.status(404).send("No chunks found");
        return;
      }

      // Sort by index
      // 分片在并行上传下入库顺序是乱的，必须按 chunkIndex 排序才能还原原始字节序。
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

      // Calculate total size
      // 虚拟文件总长 = 各分片长度之和。这个值同时用于 Content-Range 的分母，
      // 播放器据此计算进度条与可 seek 范围。
      const totalSize = chunks.reduce((sum, c) => sum + c.chunkSize, 0);

      // Handle Range request
      const rangeHeader = req.headers.range;
      let start = 0;
      let end = totalSize - 1;

      if (rangeHeader) {
        // 只解析 `bytes=<start>-<end?>` 形式；开放式 Range（如 `bytes=1000-`）会
        // 被主动截断为 5MB 一段，而不是把剩余整段吐出去。
        // 为什么要截断：浏览器起播时常发 `bytes=0-` 请求整个文件，若照单全收，
        // Node 就要串行拉完所有分片、长时间占用连接与内存；限成 5MB 后播放器会
        // 自动继续发下一段 Range，等效于分块传输，且 seek 响应更快。
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          start = parseInt(match[1]);
          end = match[2] ? parseInt(match[2]) : Math.min(start + 5 * 1024 * 1024 - 1, totalSize - 1); // Max 5MB per response
        }
      }

      const contentLength = end - start + 1;

      if (rangeHeader) {
        res.status(206);
        res.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      } else {
        res.status(200);
      }

      // Accept-Ranges 必须声明，否则浏览器认为不可 seek，进度条会被禁用。
      // max-age=3600（1 小时）：视频内容不可变，但 presigned URL 会过期，
      // 一小时是内容缓存收益与签名有效期之间的折中。
      res.set("Content-Type", "video/mp4");
      res.set("Content-Length", contentLength.toString());
      res.set("Accept-Ranges", "bytes");
      res.set("Cache-Control", "public, max-age=3600");

      // Find which chunks we need to serve
      // ---- 跨分片区间映射的核心循环 ----
      // 把「虚拟文件的 [start, end] 全局字节区间」翻译成「每个分片内部的
      // [readStart, readEnd] 局部区间」，逐分片拉取并顺序写出。
      //   currentOffset —— 当前分片在虚拟文件中的起始偏移（游标随遍历推进）
      //   bytesWritten  —— 已写出的字节数，用于精确截断与提前收尾
      let currentOffset = 0;
      let bytesWritten = 0;

      for (const chunk of chunks) {
        const chunkStart = currentOffset;
        const chunkEnd = currentOffset + chunk.chunkSize - 1;

        // Skip chunks entirely before the requested range
        // 该分片整体落在请求区间左侧：跳过，但仍要推进游标
        if (chunkEnd < start) {
          currentOffset += chunk.chunkSize;
          continue;
        }

        // Stop if we've written all requested bytes
        if (bytesWritten >= contentLength) break;

        // Calculate the byte range within this chunk
        // 全局区间 → 分片内局部区间的转换：
        //   首个命中分片可能要从中间开始读（start - chunkStart）
        //   末个命中分片可能要提前结束（end - chunkStart）
        //   中间分片则是整片读取（0 .. chunkSize-1）
        const readStart = Math.max(0, start - chunkStart);
        const readEnd = Math.min(chunk.chunkSize - 1, end - chunkStart);

        try {
          const signedUrl = await getSignedUrl(chunk.storageKey);
          const fetchHeaders: Record<string, string> = {};
          
          // Only request partial content if we don't need the whole chunk
          if (readStart > 0 || readEnd < chunk.chunkSize - 1) {
            fetchHeaders["Range"] = `bytes=${readStart}-${readEnd}`;
          }

          const upstream = await fetch(signedUrl, { headers: fetchHeaders });

          // 206 = 上游按 Range 返回了部分内容；200 = 返回了整片。两者都算成功。
          if (upstream.ok || upstream.status === 206) {
            if (upstream.body) {
              // 用 WHATWG ReadableStream reader 逐块转发，避免把整个分片读进内存。
              // 每次写出前都检查两件事：
              //   1) res.writableEnded —— 客户端可能已中断连接（seek/关闭页面），
              //      再写会抛 ERR_STREAM_WRITE_AFTER_END
              //   2) remaining —— 上游可能多给了字节（例如未按 Range 返回整片），
              //      必须切片截断，保证写出量与已声明的 Content-Length 严格一致，
              //      否则浏览器会判定响应损坏
              const reader = upstream.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (!res.writableEnded) {
                  const remaining = contentLength - bytesWritten;
                  if (value.length <= remaining) {
                    res.write(value);
                    bytesWritten += value.length;
                  } else {
                    // Only write what we need
                    res.write(value.slice(0, remaining));
                    bytesWritten += remaining;
                    break;
                  }
                } else {
                  break;
                }
              }
            }
          } else {
            console.error(`[VideoStream] Failed to fetch chunk ${chunk.chunkIndex}: ${upstream.status}`);
            break;
          }
        } catch (err) {
          // 单个分片失败时只能中断整段传输：header 早已发出（含 Content-Length），
          // 无法再改成 5xx，只能让连接提前结束由客户端自行重试 Range。
          console.error(`[VideoStream] Error streaming chunk ${chunk.chunkIndex}:`, err);
          break;
        }

        currentOffset += chunk.chunkSize;
      }

      if (!res.writableEnded) {
        res.end();
      }
    } catch (err) {
      console.error("[VideoStream] Error:", err);
      // headersSent 判断：一旦开始写响应体就不能再设置状态码，
      // 此时只能静默失败（上面的 res.end() 已把连接收尾）。
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });

  /**
   * GET /api/video-thumbnail/:videoId
   * 只回源**第一个分片**，供前端生成封面/预览。
   *
   * 为什么只要第一片：MP4 的 moov（含首帧关键帧）通常位于文件头部，前端把这段
   * 字节丢给 <video> 就能 seek 到 0 秒截图，无需下载整个大文件。
   *
   * 与 /api/video-stream 的关键差异：这里是**代理**而非 302 重定向。注释里写明了
   * 原因 —— 直接跳转到 S3 presigned URL 时响应的 Content-Type 往往是
   * `application/octet-stream`（分片上传时按二进制存的），浏览器不会当作视频解码；
   * 代理后我们可以强制改写成 `video/mp4`。
   *
   * @param req.params.videoId 数字视频 ID，非法则 400
   * @param req.headers.range  若客户端带了 Range，会原样透传给上游并回传 206
   * @returns 200/206 视频字节；单文件视频则 307 重定向；找不到 404
   * 副作用：读 videos + video_upload_chunks 表；一次 presign + 一次 S3 fetch
   * 权限级别：public
   *
   * 注意：`generatePlaceholderThumbnail()`（videoThumbnail.ts）拼出的
   * `?title=` 查询参数在本端点里并不会被使用。
   */
  // Endpoint: /api/video-thumbnail/:videoId
  // Returns the first chunk's first few bytes for thumbnail generation
  app.get("/api/video-thumbnail/:videoId", async (req: Request, res: Response) => {
    const videoId = parseInt(req.params.videoId);
    if (isNaN(videoId)) {
      res.status(400).send("Invalid video ID");
      return;
    }

    try {
      const db = await getDb();
      if (!db) {
        res.status(500).send("Database not available");
        return;
      }

      // Get video record
      const videoRecords = await db
        .select()
        .from(videos)
        .where(eq(videos.id, videoId))
        .limit(1);

      if (videoRecords.length === 0) {
        res.status(404).send("Video not found");
        return;
      }

      const video = videoRecords[0];
      const videoUrl = video.videoUrl;

      if (!videoUrl || !videoUrl.startsWith("multi-chunk:")) {
        // Not a multi-chunk video, redirect to storage
        if (videoUrl) {
          res.redirect(307, videoUrl);
        } else {
          res.status(404).send("No video URL");
        }
        return;
      }

      // Get first chunk for thumbnail
      const sessionId = videoUrl.replace("multi-chunk:", "");
      const chunks = await db
        .select()
        .from(videoUploadChunks)
        .where(eq(videoUploadChunks.sessionId, sessionId));

      if (chunks.length === 0) {
        res.status(404).send("No chunks found");
        return;
      }

      // Get first chunk
      // 同样要先排序：入库顺序不代表字节顺序，chunkIndex === 0 才是文件真正的开头
      chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      const firstChunk = chunks[0];

      // Proxy the first chunk directly (not redirect) so browser gets correct Content-Type
      const signedUrl = await getSignedUrl(firstChunk.storageKey);
      const upstream = await fetch(signedUrl, {
        headers: req.headers.range ? { Range: req.headers.range } : {},
      });

      if (!upstream.ok && upstream.status !== 206) {
        res.status(upstream.status).send("Failed to fetch video chunk");
        return;
      }

      // Set correct headers for video streaming
      // 强制改写 Content-Type：S3 上分片是以 application/octet-stream 存的，
      // 不改的话浏览器会当成下载文件而非可解码的视频流。
      res.set("Content-Type", "video/mp4");
      res.set("Accept-Ranges", "bytes");
      res.set("Cache-Control", "public, max-age=3600"); // 封面帧不变，缓存 1 小时

      // Forward range response headers if present
      // 透传上游的 Content-Range / Content-Length，保持 206 语义完整，
      // 否则播放器无法得知分片边界。
      const contentRange = upstream.headers.get("content-range");
      const contentLength = upstream.headers.get("content-length");
      if (contentRange) res.set("Content-Range", contentRange);
      if (contentLength) res.set("Content-Length", contentLength);

      // 上游若返回 206 则我们也返回 206；其余成功状态一律归一化成 200
      res.status(upstream.status === 206 ? 206 : 200);

      // Stream the response
      // 逐块转发，不做长度截断（这里的响应长度完全由上游决定）
      if (upstream.body) {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(value);
        }
      }

      res.end();
    } catch (err) {
      console.error("[VideoThumbnail] Error:", err);
      if (!res.headersSent) {
        res.status(500).send("Internal server error");
      }
    }
  });
}
