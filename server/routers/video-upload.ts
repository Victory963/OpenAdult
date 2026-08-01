/**
 * ============================================================================
 * server/routers/video-upload.ts — 视频分片上传路由 **V1（内存版，遗留实现）**
 * ============================================================================
 *
 * 【架构定位】
 * 属于「路由层（tRPC router）」。在 `server/routers.ts` 中以 `videoUpload` 键注册，
 * 与 V2 版本（`server/routers/video-upload-v2.ts`，注册名 `videoUploadV2`）并存。
 * 按照 CLAUDE.md 的「双版本路由」设计决策：**V2 为增强版，V1 仅保留向后兼容**，
 * 新功能一律进 V2。当前前端 `client/src/components/VideoUploadForm.tsx` 调用的是
 * `trpc.videoUploadV2.*`，本文件的 procedure 实际已无前端调用方（详见文末说明）。
 *
 * 【主要导出物】
 * - `videoUploadRouter` — tRPC router，包含 5 个 procedure，构成一条分片上传状态机：
 *     initSession    → 校验并创建内存上传会话，返回 sessionId
 *     uploadChunk    → 接收 base64 分片，暂存进内存 Map
 *     completeUpload → 按 index 顺序拼接所有分片 → 上传 S3 → LLM 生成元数据 → 写 videos 表
 *     cancelUpload   → 丢弃内存会话
 *     getProgress    → 查询已上传分片数与百分比
 *
 * 【上下游依赖】
 * - 上游调用方：tRPC HTTP handler（`server/_core/index.ts` 挂载的 `/api/trpc/*`）。
 * - 下游依赖：
 *     `getDb()`      ← server/db.ts        （写 videos 表）
 *     `storagePut()` ← server/storage.ts   （通过存储代理 PUT 到 S3/B2）
 *     `invokeLLM()`  ← server/_core/llm.ts （根据文件名推断标题/描述/分类）
 *     `videos` 表定义 ← drizzle/schema.ts
 *
 * 【权限模型】
 * 全部 procedure 均为 `protectedProcedure`（要求已登录），并在 handler 内部**再次**
 * 手动校验 `ctx.user.role === "admin"`，即等效于 admin 级别。之所以不用
 * `adminProcedure`，猜测是历史写法；行为上等价，但错误信息更具体（"Only admins can
 * upload videos"）。
 *
 * 【关键设计决策 / 坑】
 * 1. **会话状态全部存在进程内存**（模块级 `uploadSessions` Map），因此：
 *    - 多实例 / 多 worker 部署时，分片必须命中同一个进程，否则会话找不到；
 *    - 进程重启即丢失全部进行中的上传，且没有断点续传能力；
 *    - 分片 Buffer 常驻堆内存，声明支持 100GB 但实际上远达不到（会 OOM）。
 *    V2 正是为了解决这三点，改为「会话落库 + 分片直传 S3」。
 * 2. 分片通过 **base64 字符串**走 tRPC JSON 传输，体积膨胀约 33%，且要经过
 *    JSON 解析；V2 配套的 `/api/upload/chunk`（server/_core/fastUpload.ts）改走
 *    multipart 二进制正是为了绕开这层开销。
 * 3. sessionId 本身即是操作凭证，handler 未校验会话归属者是否为当前用户。
 */
import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
// 注意：`videoActresses` 在本文件中未被使用（V1 不做视频-女优关联），属残留 import。
import { videos, videoActresses } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { invokeLLM } from "../_core/llm";
import path from "path";

// Store upload sessions in memory (in production, use Redis or database)
// 模块级单例：sessionId → 会话状态。key 为 initSession 生成的 sessionId。
//   chunks       — 已收到的分片，Map<分片下标, 分片二进制>。用 Map 而非数组，
//                  是为了允许分片**乱序 / 并发**到达，completeUpload 时再按下标排序拼接。
//   totalChunks  — 客户端声明的分片总数，作为 completeUpload 的完整性判据。
//   totalSize    — 客户端声明的文件字节数（仅用于 initSession 阶段的大小校验，之后未再使用）。
//   uploadedAt   — 会话创建时间，供下方定时清理判断是否过期。
//   thumbnailData/duration — 客户端预先在浏览器端抽取的封面(data URL)与时长；
//                  completeUpload 时封面会被解码上传到 S3、时长直接写入 videos 行
//                  （与 V2 的 completeUpload 行为一致）。
const uploadSessions = new Map<string, {
  chunks: Map<number, Buffer>;
  totalChunks: number;
  totalSize: number;
  fileName: string;
  uploadedAt: Date;
  thumbnailData?: string;
  duration?: number;
}>();

// Clean up old sessions every hour
// 内存回收兜底：每小时扫描一次，删除创建时间超过 1 小时的会话。
// 3600000 ms = 1 小时；扫描周期与过期阈值刻意取同一个值，因此一个会话最长可能
// 存活约 2 小时（刚创建就错过本轮扫描的最坏情况）。
// 为什么必须有：会话里存的是完整文件的分片 Buffer，客户端中断上传后若不清理，
// 这些内存永远不会被 GC（Map 持有强引用），进程会持续泄漏直至 OOM。
// 先 `Array.from(...)` 快照再遍历，是为了在循环中安全地 `delete` 而不影响迭代器。
setInterval(() => {
  const now = Date.now();
  const entries = Array.from(uploadSessions.entries());
  for (const [sessionId, session] of entries) {
    if (now - session.uploadedAt.getTime() > 3600000) {
      uploadSessions.delete(sessionId);
    }
  }
}, 3600000);

/**
 * 视频上传 V1 路由集合。
 * 挂载点：`appRouter.videoUpload`（server/routers.ts）。
 * 前端调用形如 `trpc.videoUpload.initSession.useMutation()`。
 */
export const videoUploadRouter = router({
  /**
   * initSession — 初始化一次分片上传会话（mutation）。
   *
   * 权限：protected + 手动 admin 校验（非 admin 抛 FORBIDDEN）。
   * 副作用：在进程内存 `uploadSessions` 中创建一条会话记录（不写库、不写 S3）。
   *
   * @param input.fileName      原始文件名，用于扩展名白名单校验，并作为后续 LLM 推断标题的输入
   * @param input.fileSize      文件总字节数，仅用于 100GB 上限校验
   * @param input.totalChunks   客户端切分出的分片总数，completeUpload 以此判定是否收齐
   * @param input.thumbnailData 可选，浏览器端抽取的封面 data URL（completeUpload 时上传 S3）
   * @param input.duration      可选，视频时长（秒）（completeUpload 时写入 videos.duration）
   * @returns { sessionId, message } sessionId 是后续所有 procedure 的唯一句柄
   *
   * @throws TRPCError FORBIDDEN    非 admin
   * @throws TRPCError BAD_REQUEST  超过 100GB / 扩展名不在白名单
   */
  initSession: protectedProcedure
    .input(
      z.object({
        fileName: z.string(),
        fileSize: z.number().int().positive(),
        totalChunks: z.number().int().positive(),
        thumbnailData: z.string().optional(),
        duration: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can upload videos",
        });
      }

      // Validate file size (100GB max)
      // 100GB 上限：与前端 `MAX_FILE_SIZE`（VideoUploadForm.tsx）保持一致，
      // 服务端复核一遍防止绕过前端直接打 API。
      // 注意这是「声明值」校验，实际传了多少字节并未与之核对。
      const maxSize = 100 * 1024 * 1024 * 1024; // 100GB
      if (input.fileSize > maxSize) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "File size exceeds 100GB limit",
        });
      }

      // Validate file extension
      // 扩展名白名单：只做「格式可被后续 FFmpeg 转码 / 浏览器播放」的粗筛，
      // 不检测真实文件魔数（magic number），所以不能当作安全边界看待。
      // 该白名单需与前端 VideoUploadForm.tsx 的 `allowedFormats` 保持同步。
      const ext = path.extname(input.fileName).toLowerCase();
      const allowedExts = [".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".m4v"];
      if (!allowedExts.includes(ext)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `File format not supported. Allowed: ${allowedExts.join(", ")}`,
        });
      }

      // sessionId 结构：`<用户ID>-<毫秒时间戳>-<9位36进制随机串>`。
      // 三段拼接的目的：用户 ID 便于日志溯源，时间戳保证同一用户的自然有序，
      // 随机串避免同毫秒并发上传撞 key。注意随机源是 Math.random（非密码学安全），
      // 而 sessionId 又同时充当操作凭证，属于弱设计（V2 沿用了同一套生成方式）。
      const sessionId = `${ctx.user.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      uploadSessions.set(sessionId, {
        chunks: new Map(),
        totalChunks: input.totalChunks,
        totalSize: input.fileSize,
        fileName: input.fileName,
        uploadedAt: new Date(),
        thumbnailData: input.thumbnailData,
        duration: input.duration,
      });

      return {
        sessionId,
        message: "Upload session initialized",
      };
    }),

  /**
   * uploadChunk — 上传单个分片（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   * 副作用：仅写进程内存（`session.chunks`），不落库、不写 S3。
   *
   * @param input.sessionId  initSession 返回的会话句柄
   * @param input.chunkIndex 分片下标（从 0 开始），允许乱序/并发上传
   * @param input.chunkData  分片内容的 **base64 编码**字符串（JSON 传输，体积约 +33%）
   * @returns 当前进度快照 { success, chunkIndex, uploadedChunks, totalChunks, progress(0-100) }
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError BAD_REQUEST           sessionId 不存在（含被定时清理掉的过期会话）
   * @throws TRPCError INTERNAL_SERVER_ERROR base64 解码等异常
   */
  // Upload chunk
  uploadChunk: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
        chunkIndex: z.number().int().min(0),
        chunkData: z.string(), // Base64 encoded
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can upload videos",
        });
      }

      const session = uploadSessions.get(input.sessionId);
      if (!session) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid session ID",
        });
      }

      try {
        // Decode base64 chunk
        // 以 chunkIndex 为 key 覆盖写入：客户端重试同一分片是幂等的（不会重复计数），
        // 这也是进度用 `chunks.size`（去重后的分片个数）而非累加计数器的原因。
        // 注意 Buffer.from(..., "base64") 对非法字符是静默忽略而非报错，
        // 所以损坏的分片这里发现不了，要等 completeUpload 之后才体现为坏视频。
        const chunkBuffer = Buffer.from(input.chunkData, "base64");
        session.chunks.set(input.chunkIndex, chunkBuffer);

        const uploadedChunks = session.chunks.size;
        const progress = Math.round((uploadedChunks / session.totalChunks) * 100);

        return {
          success: true,
          chunkIndex: input.chunkIndex,
          uploadedChunks,
          totalChunks: session.totalChunks,
          progress,
        };
      } catch (error) {
        console.error("[Video Upload] Error uploading chunk:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to upload chunk",
        });
      }
    }),

  /**
   * completeUpload — 收尾：拼接分片 → 上传 S3 → LLM 生成元数据 → 落库 videos（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   *
   * 副作用（按发生顺序，注意本流程**不是事务性的**）：
   *   1) 写 S3：`videos/<userId>/<timestamp>-<原文件名>`（storagePut）
   *   2) 调 LLM：invokeLLM 依据文件名推断 title/description/category（失败可降级）
   *   3) 写 S3：封面 `thumbnails/<userId>/<ts>-thumb.jpg`（仅当会话里有 thumbnailData，失败可降级）
   *   4) 写库：向 `videos` 表 INSERT 一行（含 thumbnailUrl 与 duration）
   *   5) 清理：从内存删除该会话
   * 若第 4 步失败，前面已写入 S3 的对象不会被回滚，会成为孤儿文件。
   *
   * @param input.sessionId 会话句柄
   * @returns { success, videoId, videoUrl, storageKey, metadata, message }
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError BAD_REQUEST           会话不存在，或分片数与 totalChunks 不符
   * @throws TRPCError INTERNAL_SERVER_ERROR S3/DB 失败（原始错误只打日志，不外泄给客户端）
   */
  // Complete upload and process video
  completeUpload: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can upload videos",
        });
      }

      const session = uploadSessions.get(input.sessionId);
      if (!session) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid session ID",
        });
      }

      // 完整性前置校验：只比对「分片个数」。因为 chunks 是以 index 为 key 的 Map，
      // size === totalChunks 并不能 100% 保证下标恰好是 0..totalChunks-1
      // （客户端若上传了越界下标就会漏），所以下面拼接时还会逐个 get(i) 再校验一次。
      if (session.chunks.size !== session.totalChunks) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Missing chunks. Expected ${session.totalChunks}, got ${session.chunks.size}`,
        });
      }

      try {
        // Combine chunks
        // 按下标 0..totalChunks-1 **顺序**取出分片再 concat —— 这一步是整个乱序上传能
        // 还原成正确文件的关键：Map 的插入顺序 = 网络到达顺序，直接遍历 Map 会得到乱序数据。
        const chunks: Buffer[] = [];
        for (let i = 0; i < session.totalChunks; i++) {
          const chunk = session.chunks.get(i);
          if (!chunk) {
            throw new Error(`Missing chunk ${i}`);
          }
          chunks.push(chunk);
        }
        // 一次性在内存里拼出完整文件：峰值内存约为「分片总量 + 合并后副本」≈ 2×文件大小。
        // 这是 V1 无法真正支撑大文件（更别提声明的 100GB）的根本原因。
        const videoBuffer = Buffer.concat(chunks);

        // Upload to S3
        // S3 key 形如 `videos/<userId>/<时间戳>-<原文件名>`：
        // 时间戳前缀用于避免同一用户重复上传同名文件时互相覆盖。
        // 注意 contentType 被硬编码为 "video/mp4"，即使实际是 mkv/webm 也一样
        // （V2 改为按扩展名映射，见 video-upload-v2.ts 的 contentTypeMap）。
        const timestamp = Date.now();
        const fileName = `videos/${ctx.user.id}/${timestamp}-${session.fileName}`;
        const { url, key } = await storagePut(fileName, videoBuffer, "video/mp4");

        // Use AI to analyze video content and extract title
        // 兜底元数据（LLM 不可用时直接沿用）：
        // 正则 /\.[^/.]+$/ 去掉最后一个扩展名（`[^/.]` 排除路径分隔符，避免把
        // "a.b/c" 这类含点的目录名误当扩展名），把 "ABC-123.mp4" 变成 "ABC-123"。
        let aiAnalysis = {
          title: session.fileName.replace(/\.[^/.]+$/, ""),
          description: "",
          category: "",
        };

        // LLM 只拿到**文件名**（并没有看到视频内容），所以本质是「从命名规则里
        // 猜番号/标题/分类」。整段包在 try/catch 里：LLM 属于可降级依赖，
        // 分析失败绝不能让已经上传成功的视频落库失败。
        try {
          const response = await invokeLLM({
            messages: [
              {
                role: "system",
                content: "You are a video content analyzer. Analyze the video file name and provide a JSON response with title, description, and category.",
              },
              {
                role: "user",
                content: `Analyze this video file name and provide metadata: "${session.fileName}". Return JSON with fields: title (string), description (string), category (string). Only return valid JSON, no other text.` as any,
              },
            ] as any,
            // 结构化输出：strict + additionalProperties:false 强制模型只能返回
            // 恰好这三个字段的 JSON，从而让下面的 JSON.parse 基本不会失败，
            // 免去「模型加了 ```json 围栏 / 说了一句废话」之类的清洗逻辑。
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "video_metadata",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    description: { type: "string" },
                    category: { type: "string" },
                  },
                  required: ["title", "description", "category"],
                  additionalProperties: false,
                },
              },
            },
          });

          // 逐字段 `||` 兜底：模型可能返回空字符串，此时 title 回退到文件名，
          // description/category 回退到空串（而不是 undefined，避免写库时列为 NULL）。
          const content = response.choices[0]?.message?.content;
          if (content && typeof content === "string") {
            const parsed = JSON.parse(content);
            aiAnalysis = {
              title: parsed.title || aiAnalysis.title,
              description: parsed.description || "",
              category: parsed.category || "",
            };
          }
        } catch (error) {
          console.error("[Video Upload] Error analyzing video with AI:", error);
          // Continue with default analysis
          // 降级：保留上面用文件名构造的 aiAnalysis，流程继续。
        }

        // Upload thumbnail to S3 if available
        // 修复：initSession 收到的 thumbnailData / duration 此前被完全丢弃，导致 V1
        // 上传的视频永远没有封面、时长恒为 0；这里改为与 V2
        //（video-upload-v2.ts completeUpload）一致的处理方式，真正落地这两个字段。
        // 封面来自客户端在浏览器里用 <video>+canvas 抽帧得到的 data URL
        //（形如 `data:image/jpeg;base64,xxxx`），正则捕获组剥掉 MIME 前缀后只取纯载荷；
        // 不是合法 data URL 则整体跳过，thumbnailUrl 保持 null。
        // 整段可降级（try/catch 只打日志）：封面处理失败不应阻断已上传成功的视频入库。
        let thumbnailUrl: string | null = null;
        // duration 列是 MySQL int（秒），客户端给的是浮点秒数，故取整后写入。
        const videoDuration = session.duration ? Math.round(session.duration) : 0;
        try {
          if (session.thumbnailData) {
            const base64Match = session.thumbnailData.match(/^data:image\/\w+;base64,(.+)$/);
            if (base64Match) {
              const thumbnailBuffer = Buffer.from(base64Match[1], "base64");
              // 封面 key 用时间戳命名（与 V2 一致），contentType 恒为 image/jpeg
              //（前端抽帧固定导出 JPEG）。
              const thumbnailKey = `thumbnails/${ctx.user.id}/${Date.now()}-thumb.jpg`;
              const { url: thumbUrl } = await storagePut(thumbnailKey, thumbnailBuffer, "image/jpeg");
              thumbnailUrl = thumbUrl;
            }
          }
        } catch (e) {
          console.error("[Video Upload] Error processing thumbnail:", e);
        }

        // Create video record in database
        const db = await getDb();
        if (!db) throw new Error("Database not available");

        // 落库：videoUrl 直接存 storagePut 返回的**绝对 URL**。
        // 与 V2 不同 —— V2 存的是相对路径 `/manus-storage/<key>`（走服务端存储代理），
        // 两者混存会让前端 videoUrl 处理逻辑（client/src/lib/videoUrl.ts）必须兼容两种形态。
        // thumbnailUrl 同样是绝对 URL（与 V2 的封面形态一致）。
        const result = await db.insert(videos).values({
          title: aiAnalysis.title,
          description: aiAnalysis.description,
          videoUrl: url,
          thumbnailUrl,
          category: aiAnalysis.category,
          duration: videoDuration,
          tags: [],
          views: 0,
          rating: "0",
        });

        // MySQL 驱动返回的 insertId 未包含在 Drizzle 的类型里，故 as any 强转。
        const videoId = (result as any).insertId;

        // Clean up session
        // 成功后立即释放内存中的分片 Buffer（不等定时任务），这是内存回收的主路径。
        uploadSessions.delete(input.sessionId);

        return {
          success: true,
          videoId,
          videoUrl: url,
          storageKey: key,
          metadata: aiAnalysis,
          message: "Video uploaded and processed successfully",
        };
      } catch (error) {
        // 统一收敛为 500 并只回一句通用文案：避免把 S3 endpoint、SQL 语句等
        // 内部细节透给客户端；真实原因只进服务端日志。
        // 副作用提示：此分支不会删除会话，客户端可重试 completeUpload（分片仍在内存里）。
        console.error("[Video Upload] Error completing upload:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to complete upload",
        });
      }
    }),

  /**
   * cancelUpload — 取消上传（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   * 副作用：从内存删除会话，释放已缓存的分片 Buffer。
   * 幂等：sessionId 不存在时 Map.delete 静默返回 false，依然回 success:true。
   *
   * @param input.sessionId 会话句柄
   * @throws TRPCError FORBIDDEN 非 admin
   */
  // Cancel upload
  cancelUpload: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can upload videos",
        });
      }

      uploadSessions.delete(input.sessionId);

      return {
        success: true,
        message: "Upload cancelled",
      };
    }),

  /**
   * getProgress — 轮询上传进度（query，无副作用）。
   *
   * 权限：protected + 手动 admin 校验。
   * 设计取舍：会话不存在时**不抛错**，而是返回 status:"not_found" 的零值对象，
   * 便于前端轮询在会话过期/已完成后平滑收尾，而不是弹一个红色错误。
   * 因此 status 只有 "not_found" | "uploading" 两种取值 —— V1 没有持久化状态机，
   * 无法区分 processing/completed/failed（这些是 V2 才有的，见 videoUploadSessions.status）。
   *
   * @param input.sessionId 会话句柄
   * @returns { sessionId, uploadedChunks, totalChunks, progress(0-100), status }
   * @throws TRPCError FORBIDDEN 非 admin
   */
  // Get upload progress
  getProgress: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can upload videos",
        });
      }

      const session = uploadSessions.get(input.sessionId);
      if (!session) {
        return {
          sessionId: input.sessionId,
          uploadedChunks: 0,
          totalChunks: 0,
          progress: 0,
          status: "not_found",
        };
      }

      const uploadedChunks = session.chunks.size;
      const progress = Math.round((uploadedChunks / session.totalChunks) * 100);

      return {
        sessionId: input.sessionId,
        uploadedChunks,
        totalChunks: session.totalChunks,
        progress,
        status: "uploading",
      };
    }),
});
