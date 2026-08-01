/**
 * ============================================================================
 * server/routers/video-upload-v2.ts — 视频分片上传路由 **V2（持久化 + 断点续传）**
 * ============================================================================
 *
 * 【架构定位】
 * 属于「路由层（tRPC router）」。在 `server/routers.ts` 中以 `videoUploadV2` 键注册，
 * 是 CLAUDE.md「双版本路由」里的**增强版**，新功能一律进这里；V1
 * （server/routers/video-upload.ts）仅作向后兼容保留。
 *
 * 【相对 V1 的三点核心改进】
 * 1. **会话落库**：状态写 `video_upload_sessions` / `video_upload_chunks` 两张表，
 *    进程重启、多实例部署都不会丢失进度（V1 全存进程内存）。
 * 2. **分片直传 S3**：每个分片收到后立刻 `storagePut` 到
 *    `videos/<userId>/<sessionId>/chunk-<i>`，服务端不再常驻整份文件的 Buffer。
 * 3. **断点续传**：`getProgress` / `getMissingChunks` 能告诉客户端哪些下标还没传，
 *    客户端只补传缺失分片即可。
 *
 * 【主要导出物】
 * - `videoUploadV2Router` — tRPC router，procedure 构成如下状态机：
 *
 *     initSession ──▶ status="uploading" ──(uploadChunk × N)──▶ completeUpload
 *                                                 │                  │
 *                                                 │                  ├─▶ status="processing"
 *                                                 │                  └─▶ status="completed"
 *                                                 ▼
 *                                        getProgress / getMissingChunks（只读，供续传）
 *                                                 │
 *                                          cancelUpload ──▶ 删除 chunks + session 行
 *
 *   注：schema 里定义的 `failed` 状态在本文件中**从未被写入**（失败路径只抛错，不改状态）。
 *
 * 【上下游依赖】
 * - 上游调用方：`client/src/components/VideoUploadForm.tsx`
 *   （只用到 `initSession` 与 `completeUpload`）。
 * - **重要**：真实的分片上传走的不是本文件的 `uploadChunk`，而是二进制快速通道
 *   `POST /api/upload/chunk`（server/_core/fastUpload.ts，multipart/form-data，
 *   支持并发 + 重试）。本文件的 `uploadChunk`（base64 over tRPC）是等价的备用/遗留实现。
 *   两条路径写的是同一批表，但**维护的字段不同**（见 uploadChunk 处的注释）。
 * - 下游依赖：`getDb()`（server/db.ts）、`storagePut/storageGet`（server/storage.ts）、
 *   `invokeLLM()`（server/_core/llm.ts）、drizzle schema 中的 videos /
 *   videoUploadSessions / videoUploadChunks。
 *
 * 【权限模型】
 * 所有 procedure 均为 `protectedProcedure` + handler 内手动 `role === "admin"` 校验，
 * 等效于 admin 级别。注意：**未校验会话归属**（`videoUploadSessions.userId` 从不与
 * `ctx.user.id` 比对），任意 admin 只要拿到 sessionId 就能操作他人的上传会话。
 *
 * 【坑位提醒】
 * - `completeUpload` 仍然把所有分片下载回内存 concat 后再整体上传，因此「100GB 上限」
 *   只是校验值，实际可用体积受进程内存约束。
 * - 合并完成后 S3 上的分片对象与 `video_upload_chunks` 行都不会被删除（存储泄漏）。
 * - `expiresAt` 只写不读，没有任何过期清理任务。
 */
import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "../db";
// 注意：`videoActresses` 在本文件中未被使用（上传流程不建立视频-女优关联，
// 该关联由 client/src/components/VideoActressLinker.tsx + 女优管理路由负责）。
import { videos, videoActresses, videoUploadSessions, videoUploadChunks } from "../../drizzle/schema";
import { storagePut, storageGet } from "../storage";
import { invokeLLM } from "../_core/llm";
// `and` 目前亦未被使用，仅 `eq` / `sql` 有实际调用。
import { eq, and, sql } from "drizzle-orm";
import path from "path";
import crypto from "crypto";

/**
 * 视频上传 V2 路由集合。
 * 挂载点：`appRouter.videoUploadV2`（server/routers.ts）。
 */
export const videoUploadV2Router = router({
  /**
   * initSession — 创建一条**持久化**的上传会话（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   * 副作用：向 `video_upload_sessions` INSERT 一行（status="uploading"）。
   *
   * @param input.fileName      原始文件名；既用于扩展名白名单校验，也是 completeUpload 时
   *                            LLM 推断标题的唯一输入，同时决定最终 S3 对象的扩展名
   * @param input.fileSize      文件字节数，**bigint**（V1 用 number）——因为列类型是
   *                            MySQL bigint，且 100GB 级数值需要与 DB 精度对齐
   * @param input.totalChunks   分片总数（前端按 CHUNK_SIZE 切分得出）
   * @param input.thumbnailData 可选，浏览器 canvas 抽帧得到的封面 data URL；
   *                            与 duration 一起序列化进 `metadata` 列，completeUpload 时才落地
   * @param input.duration      可选，视频时长（秒）
   * @returns { sessionId, message } sessionId 同时也是分片在 S3 上的目录名
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError BAD_REQUEST           超过 100GB / 扩展名不在白名单
   * @throws TRPCError INTERNAL_SERVER_ERROR 建会话写库失败
   */
  // Initialize upload session with persistence
  initSession: protectedProcedure
    .input(
      z.object({
        fileName: z.string(),
        fileSize: z.bigint(),
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

      // 100GB 上限，与前端 `MAX_FILE_SIZE`（VideoUploadForm.tsx）保持一致。
      // 这里全程用 BigInt 运算：fileSize 列是 MySQL bigint，且 100GB≈1.07e11 虽仍在
      // Number 安全整数范围内，但与 bigint 类型的 input 混算会直接 TypeError，故统一为 BigInt。
      const maxSize = BigInt(100) * BigInt(1024) * BigInt(1024) * BigInt(1024); // 100GB
      if (input.fileSize > maxSize) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "File size exceeds 100GB limit",
        });
      }

      // 扩展名白名单：仅粗筛容器格式，不校验文件魔数，不能当安全边界。
      // 需与前端 VideoUploadForm.tsx 的 `allowedFormats` 及 V1 的同名列表保持同步。
      const ext = path.extname(input.fileName).toLowerCase();
      const allowedExts = [".mp4", ".webm", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".m4v"];
      if (!allowedExts.includes(ext)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `File format not supported. Allowed: ${allowedExts.join(", ")}`,
        });
      }

      // sessionId 结构同 V1：`<用户ID>-<毫秒时间戳>-<9位36进制随机串>`。
      // 在 V2 中它还额外承担两个角色：① S3 分片目录名 `videos/<uid>/<sessionId>/chunk-N`；
      // ② 最终视频对象名 `videos/<uid>/<sessionId>.<ext>`。所以它必须是文件名安全字符
      //（`-` 与 36 进制字符集天然满足），且随机源为 Math.random（非密码学安全）。
      const sessionId = `${ctx.user.id}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      // 24 小时过期时间：大文件上传可能跨天，给足断点续传窗口。
      // 【坑】该字段只在这里写入，全项目没有任何地方读取或据此清理过期会话，
      //       所以未完成的会话行与其 S3 分片会永久残留。
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        await db.insert(videoUploadSessions).values({
          id: sessionId,
          userId: ctx.user.id as number,
          fileName: input.fileName,
          fileSize: input.fileSize,
          totalChunks: input.totalChunks,
          uploadedChunks: 0,
          status: "uploading",
          expiresAt,
          // metadata 列（mediumtext）在会话生命周期内**语义会变**：
          //   uploading 阶段 → { thumbnailData, duration }（客户端预处理结果）
          //   completed 阶段 → { title, description, category }（LLM 分析结果，见 completeUpload）
          // 即后者会整体覆盖前者，缩略图 base64 不会长期占用该列。
          metadata: JSON.stringify({
            thumbnailData: input.thumbnailData,
            duration: input.duration,
          }),
        });

        return {
          sessionId,
          message: "Upload session initialized",
        };
      } catch (error) {
        console.error("[Video Upload V2] Error initializing session:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to initialize upload session",
        });
      }
    }),

  /**
   * uploadChunk — 上传单个分片并**直传 S3**（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   *
   * 副作用（三写）：
   *   1) 写 S3：`videos/<userId>/<sessionId>/chunk-<index>`
   *   2) 写库：`video_upload_chunks` INSERT 一行（含 sha256 校验和）
   *   3) 写库：回写 `video_upload_sessions.uploadedChunks` / `uploadedChunkIds`
   *
   * ⚠️ 与 `POST /api/upload/chunk`（server/_core/fastUpload.ts）的差异：
   *   - 那条二进制通道用 `onDuplicateKeyUpdate` 处理重试去重，并用 `COUNT(*)` 重算进度
   *     （并发安全），但**不维护 `uploadedChunkIds`**；
   *   - 本 procedure 反之：维护 `uploadedChunkIds`，但用「读-改-写」方式累加，
   *     并发上传时存在 lost update；重复上传同一 index 也会重复追加。
   *   两条路径混用会让 `getMissingChunks`（依赖 uploadedChunkIds）给出错误结论。
   *
   * @param input.sessionId  会话句柄
   * @param input.chunkIndex 分片下标（从 0 开始）
   * @param input.chunkData  base64 编码的分片内容
   * @returns { success, chunkIndex, uploadedChunks, totalChunks, progress }
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError BAD_REQUEST           sessionId 不存在
   * @throws TRPCError INTERNAL_SERVER_ERROR S3 / DB 失败
   */
  // Upload chunk with direct S3 storage
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

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Get session
        const session = await db
          .select()
          .from(videoUploadSessions)
          .where(eq(videoUploadSessions.id, input.sessionId))
          .limit(1);

        if (session.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid session ID",
          });
        }

        const sessionData = session[0];

        // Decode chunk
        // sha256 校验和存库（checksum 列 64 字符，正好是 sha256 的十六进制长度），
        // 用于事后排查分片是否损坏；当前 completeUpload 并未真正做校验比对。
        const chunkBuffer = Buffer.from(input.chunkData, "base64");
        const checksum = crypto.createHash("sha256").update(chunkBuffer).digest("hex");

        // Upload chunk directly to S3
        // 分片按 sessionId 分目录存放，好处：① 天然隔离不同上传；
        // ② cancelUpload / 事后清理可按前缀批量处理；③ 与 fastUpload.ts 生成的 key 完全一致，
        // 所以两条上传通道可以混用同一批分片。
        // contentType 用 application/octet-stream —— 分片是无意义的字节切片，不是可播放媒体。
        const chunkStorageKey = `videos/${ctx.user.id}/${sessionData.id}/chunk-${input.chunkIndex}`;
        const { key } = await storagePut(chunkStorageKey, chunkBuffer, "application/octet-stream");

        // Save chunk metadata
        // 只存「指针 + 元信息」，分片内容留在 S3 —— 这是 V2 不再吃内存的关键。
        await db.insert(videoUploadChunks).values({
          sessionId: input.sessionId,
          chunkIndex: input.chunkIndex,
          chunkSize: chunkBuffer.length,
          storageKey: key,
          checksum,
        });

        // Update session
        // 读-改-写维护「已上传下标数组」：反序列化 → push 当前下标 → 再序列化写回。
        // 该数组是 getMissingChunks 判定缺口的唯一依据（因此续传能力依赖它的正确性）。
        // 【并发隐患】读与写之间没有加锁 / 没有走 SQL 原子更新，多个分片并发调用本
        // procedure 时后写覆盖先写，会丢下标；同一下标重试还会被重复 push，
        // 导致 uploadedChunks 计数虚高（可能 > totalChunks，使 progress 超过 100）。
        const uploadedChunkIds = sessionData.uploadedChunkIds
          ? JSON.parse(sessionData.uploadedChunkIds as string)
          : [];
        uploadedChunkIds.push(input.chunkIndex);

        await db
          .update(videoUploadSessions)
          .set({
            uploadedChunks: uploadedChunkIds.length,
            uploadedChunkIds: JSON.stringify(uploadedChunkIds),
          })
          .where(eq(videoUploadSessions.id, input.sessionId));

        const progress = Math.round((uploadedChunkIds.length / sessionData.totalChunks) * 100);

        return {
          success: true,
          chunkIndex: input.chunkIndex,
          uploadedChunks: uploadedChunkIds.length,
          totalChunks: sessionData.totalChunks,
          progress,
        };
      } catch (error: any) {
        console.error("[Video Upload V2] Error uploading chunk:", error);
        // 透传语义化错误：上面主动抛出的 TRPCError({code:"BAD_REQUEST"}) 也会被本
        // catch 捕获，若不区分就会被降级成 500，客户端将无法识别「会话失效」。
        // 判据是 TRPCError 实例上的 `code` 字段。
        if (error.code === "BAD_REQUEST") throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to upload chunk",
        });
      }
    }),

  /**
   * completeUpload — 收尾：校验分片齐全 → LLM 元数据 → 落封面 → 合并分片 → 落库（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   *
   * 完整副作用链（**非事务**，任一步失败都可能留下中间态）：
   *   1) 写库：session.status = "processing"
   *   2) 调 LLM：由文件名推断 title/description/category（可降级）
   *   3) 写 S3：封面 `thumbnails/<userId>/<ts>-thumb.jpg`（若客户端提供了 thumbnailData）
   *   4) 读 S3：逐个下载全部分片
   *   5) 写 S3：合并后的完整视频 `videos/<userId>/<sessionId>.<ext>`
   *   6) 写库：`videos` 表 INSERT 一行
   *   7) 写库：session.status = "completed"，metadata 覆盖为 LLM 结果
   *   注意：**分片对象与 video_upload_chunks 行始终不会被清理**（存储/表膨胀）。
   *
   * @param input.sessionId 会话句柄
   * @returns { success, videoId, videoUrl, metadata, message }
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError BAD_REQUEST           会话不存在，或 DB 中分片行数 ≠ totalChunks
   * @throws TRPCError INTERNAL_SERVER_ERROR S3 / DB 失败
   */
  // Complete upload and analyze video
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

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Get session
        const session = await db
          .select()
          .from(videoUploadSessions)
          .where(eq(videoUploadSessions.id, input.sessionId))
          .limit(1);

        if (session.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid session ID",
          });
        }

        const sessionData = session[0];

        // Count actual chunks in DB (race-condition safe)
        // 完整性判据刻意用 `SELECT COUNT(*) FROM video_upload_chunks` 实时统计，
        // 而**不信任** session.uploadedChunks 计数列：后者由两条上传通道各自更新，
        // 并发下可能偏大或偏小（见 uploadChunk 处的并发隐患说明）。
        // COUNT(*) 直接反映真实落库的分片行数，是唯一可靠来源。
        const chunkCountResult = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(videoUploadChunks)
          .where(eq(videoUploadChunks.sessionId, input.sessionId));
        // 驱动可能把 COUNT(*) 以字符串/BigInt 返回，统一 Number() 归一化，?? 0 兜空结果。
        const actualChunkCount = Number(chunkCountResult[0]?.count ?? 0);

        if (actualChunkCount !== sessionData.totalChunks) {
          // Update session with actual count before throwing
          // 抛错前先把真实分片数回写到会话行：这样客户端随后调用 getProgress /
          // getMissingChunks 时看到的是纠正后的进度，能据此补传缺失分片而不是从头再来。
          await db
            .update(videoUploadSessions)
            .set({ uploadedChunks: actualChunkCount })
            .where(eq(videoUploadSessions.id, input.sessionId));
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Missing chunks. Expected ${sessionData.totalChunks}, got ${actualChunkCount}`,
          });
        }

        // Update session status
        // 状态机推进：uploading → processing。前端轮询 getProgress 时可据此把 UI
        // 从「上传中/百分比」切换到「处理中」（VideoUploadForm 同时也在本地设了该状态）。
        await db
          .update(videoUploadSessions)
          .set({ status: "processing" })
          .where(eq(videoUploadSessions.id, input.sessionId));

        // Analyze video with AI
        // 兜底元数据：正则 /\.[^/.]+$/ 去掉末尾扩展名（`[^/.]` 排除路径分隔符，
        // 避免误伤含点的目录名），"ABC-123.mp4" → "ABC-123"。
        let aiAnalysis = {
          title: sessionData.fileName.replace(/\.[^/.]+$/, ""),
          description: "",
          category: "",
        };

        // LLM 只看到**文件名**（没看视频内容），本质是从命名规则里猜番号/标题/分类。
        // 整段可降级：分析失败绝不能让已上传完成的视频卡住，直接沿用文件名兜底。
        try {
          const response = await invokeLLM({
            messages: [
              {
                role: "system",
                content: "You are a video content analyzer. Analyze the video file name and provide a JSON response with title, description, and category.",
              },
              {
                role: "user",
                content: `Analyze this video file name and provide metadata: "${sessionData.fileName}". Return JSON with fields: title (string), description (string), category (string). Only return valid JSON, no other text.` as any,
              },
            ] as any,
            // 结构化输出：strict + additionalProperties:false 强制模型只返回这三个字段的
            // 合法 JSON，省掉「去 ```json 围栏 / 剥离寒暄语」的清洗逻辑，
            // 下面的 JSON.parse 才敢直接跑（外层仍有 try/catch 兜底）。
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

          // 逐字段 `||` 兜底：模型返回空串时 title 回退文件名，
          // description/category 回退空串（而非 undefined，避免写库时列变 NULL）。
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
          console.error("[Video Upload V2] Error analyzing video with AI:", error);
          // 降级：保留基于文件名的 aiAnalysis，继续后续流程。
        }

        // Upload thumbnail to S3 if available
        // 封面与时长来自 initSession 时客户端在浏览器里预抽取的结果（存在 metadata 列）。
        // 之所以在浏览器端抽帧而不是服务端 FFmpeg：服务端此时只有零散分片，
        // 而且抽帧成本高；浏览器用 <video> + canvas 几乎零成本。
        // 整段可降级（try/catch 只打日志）：没有封面/时长不应阻断视频入库。
        let thumbnailUrl: string | null = null;
        let videoDuration = 0;
        try {
          const sessionMetadata = sessionData.metadata ? JSON.parse(sessionData.metadata as string) : {};
          if (sessionMetadata.thumbnailData) {
            // Extract base64 data from data URL
            // 客户端传来的是完整 data URL（形如 `data:image/jpeg;base64,xxxx`），
            // 正则捕获组 (.+) 剥掉 MIME 前缀，只取纯 base64 载荷。
            // 匹配失败（不是合法 data URL）就整体跳过，thumbnailUrl 保持 null。
            const base64Match = sessionMetadata.thumbnailData.match(/^data:image\/\w+;base64,(.+)$/);
            if (base64Match) {
              const thumbnailBuffer = Buffer.from(base64Match[1], 'base64');
              // 封面 key 用时间戳命名而非 sessionId，故与视频对象不在同一命名空间，
              // 删除视频时无法按 key 反推封面（清理时需另行记录）。
              // contentType 恒为 image/jpeg —— 前端抽帧固定导出 JPEG。
              const thumbnailKey = `thumbnails/${ctx.user.id}/${Date.now()}-thumb.jpg`;
              const { url: thumbUrl } = await storagePut(thumbnailKey, thumbnailBuffer, 'image/jpeg');
              // 注意：封面存的是 storagePut 返回的**绝对 URL**，
              // 而下面视频存的是相对路径 `/manus-storage/...`，两者形态不一致。
              thumbnailUrl = thumbUrl;
            }
          }
          if (sessionMetadata.duration) {
            videoDuration = sessionMetadata.duration;
          }
        } catch (e) {
          console.error('[Video Upload V2] Error processing thumbnail:', e);
        }

        // Merge chunks into a single video file and upload to S3
        // ---- 分片合并阶段（整个 V2 流程中最重、最脆弱的一段）----
        const chunks = await db
          .select()
          .from(videoUploadChunks)
          .where(eq(videoUploadChunks.sessionId, input.sessionId));

        // Sort chunks by index
        // 必须显式按 chunkIndex 升序排序：SQL 未加 ORDER BY，返回顺序不保证；
        // 且分片是并发上传的，自增主键顺序 = 到达顺序 ≠ 文件字节顺序。
        // 排错了顺序 → 合出来的视频直接损坏。
        chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);

        // Download and merge all chunks
        // 串行逐个把分片从 S3 拉回内存。串行而非并发，是为了压住内存峰值与出网带宽，
        // 代价是大文件下这里会非常慢（N 个分片 × 一次 presigned URL + 一次 GET）。
        // storageGet 只返回带签名的下载 URL，真正取数据靠 fetch。
        const chunkBuffers: Buffer[] = [];
        for (const chunk of chunks) {
          try {
            const { url: chunkUrl } = await storageGet(chunk.storageKey);
            const resp = await fetch(chunkUrl);
            if (resp.ok) {
              const arrayBuffer = await resp.arrayBuffer();
              chunkBuffers.push(Buffer.from(arrayBuffer));
            } else {
              // 【严重隐患】下载失败只记日志、不中断也不补偿：该分片会被静默跳过，
              // 后面 Buffer.concat 依然照常执行，结果是**缺字节的损坏视频**被当作
              // 成功上传写入 videos 表。这里本应抛错并把 session 置为 "failed"。
              console.error(`[Video Upload V2] Failed to download chunk ${chunk.chunkIndex}: ${resp.status}`);
            }
          } catch (e) {
            // 同上：网络异常同样被吞掉，只留日志。
            console.error(`[Video Upload V2] Error downloading chunk ${chunk.chunkIndex}:`, e);
          }
        }

        // Merge all chunks into one buffer
        // 一次性 concat 出完整文件：峰值内存 ≈ 2×文件大小（分片数组 + 合并副本）。
        // 这也是「100GB 上限」实际不可达的原因 —— 真正的大文件应改用 S3 分段上传
        // (Multipart Upload) 的 UploadPart/CompleteMultipartUpload，无需回到服务端内存。
        const mergedBuffer = Buffer.concat(chunkBuffers);

        // Determine content type from file extension
        // 用 split('.').pop() 取扩展名（无点时会返回整个文件名，故有 || 'mp4' 兜底）。
        // 注意这里没复用文件顶部 import 的 path.extname —— 因为需要的是**不带点**的后缀，
        // 用来同时拼 S3 key 与查 contentTypeMap。
        const ext = sessionData.fileName.split('.').pop()?.toLowerCase() || 'mp4';
        // 扩展名 → MIME 映射：只覆盖常见 5 种；白名单里的 flv/wmv/m4v 未列入，
        // 会落到默认值 video/mp4（浏览器可能因此拒绝播放，但至少不影响下载/转码）。
        const contentTypeMap: Record<string, string> = {
          mp4: 'video/mp4',
          webm: 'video/webm',
          avi: 'video/x-msvideo',
          mov: 'video/quicktime',
          mkv: 'video/x-matroska',
        };
        const videoContentType = contentTypeMap[ext] || 'video/mp4';
        
        // Upload merged video to S3
        // 最终对象 key 用 sessionId 命名（而非原始文件名）：避免中文/空格/特殊字符
        // 进入 S3 key 与 URL，同时天然保证唯一、可由会话反查。
        // 解构出的 finalVideoUrl（绝对 URL）实际并未使用，下面改用相对路径。
        const finalVideoKey = `videos/${ctx.user.id}/${sessionData.id}.${ext}`;
        const { url: finalVideoUrl } = await storagePut(finalVideoKey, mergedBuffer, videoContentType);

        // Create video record - use relative path for storage proxy
        // 刻意存**相对路径**而不是 S3 绝对 URL：请求会先打到本站
        // `/manus-storage/*`（server/_core/storageProxy.ts）再由服务端签发/代理，
        // 好处是 ① 不把存储桶域名和签名暴露给前端，② 换 S3 供应商/桶时无需刷库，
        // ③ 便于配合 CDN 与反封锁域名轮换。注意 V1 存的是绝对 URL，两种形态并存。
        const videoUrl = `/manus-storage/${finalVideoKey}`;
        const result = await db.insert(videos).values({
          title: aiAnalysis.title,
          description: aiAnalysis.description,
          videoUrl,
          thumbnailUrl,
          category: aiAnalysis.category,
          duration: videoDuration,
          tags: [],
          views: 0,
          rating: "0",
        });

        // MySQL 驱动返回的 insertId 不在 Drizzle 的返回类型里，故 as any 强转取用。
        const videoId = (result as any).insertId;

        // Update session
        // 状态机收尾：processing → completed，并把 metadata 覆盖为 LLM 结果
        //（原本存的 thumbnailData base64 因此被丢弃，避免长期占用 mediumtext 列）。
        // 注意 storageKey 写的是 sessionData.id 而非真正的对象 key（finalVideoKey），
        // 想按会话反查 S3 对象时需要自己补上 `videos/<userId>/` 前缀与扩展名。
        // 此处也**没有**清理已合并的分片（S3 对象 + video_upload_chunks 行）。
        await db
          .update(videoUploadSessions)
          .set({
            status: "completed",
            storageKey: sessionData.id,
            metadata: JSON.stringify(aiAnalysis),
          })
          .where(eq(videoUploadSessions.id, input.sessionId));

        return {
          success: true,
          videoId,
          videoUrl,
          metadata: aiAnalysis,
          message: "Video uploaded and processed successfully",
        };
      } catch (error: any) {
        console.error("[Video Upload V2] Error completing upload:", error);
        // 透传语义化错误码，其余一律收敛为 500 且只回通用文案（防泄漏内部细节）。
        // 【注意】进入本分支时会话状态仍停留在 "processing"，既不会回退到 "uploading"
        // 也不会置为 "failed"，客户端轮询会看到一个永久卡在处理中的会话。
        if (error.code === "BAD_REQUEST" || error.code === "FORBIDDEN") throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to complete upload",
        });
      }
    }),

  /**
   * getProgress — 查询上传进度，并返回续传所需的已传下标（query，无副作用）。
   *
   * 权限：protected + 手动 admin 校验。
   * 与 V1 的差异：状态来自持久化的 `videoUploadSessions.status`，因此能区分
   * uploading / processing / completed / failed 四态，进程重启后依然可查。
   *
   * @param input.sessionId 会话句柄
   * @returns 会话不存在时返回 status:"not_found" 的零值对象（**不抛错**，便于前端
   *          轮询平滑收尾）；否则返回
   *          { sessionId, uploadedChunks, totalChunks, progress, status,
   *            uploadedChunkIndices, fileName }
   *          其中 `uploadedChunkIndices` 直接来自 `video_upload_chunks` 实表，
   *          比 session.uploadedChunkIds（JSON 列，两条上传通道维护不一致）更可信。
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError INTERNAL_SERVER_ERROR 查询失败
   */
  // Get upload progress with resume capability
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
          message: "Only admins can access upload progress",
        });
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const session = await db
          .select()
          .from(videoUploadSessions)
          .where(eq(videoUploadSessions.id, input.sessionId))
          .limit(1);

        if (session.length === 0) {
          return {
            sessionId: input.sessionId,
            uploadedChunks: 0,
            totalChunks: 0,
            progress: 0,
            status: "not_found",
          };
        }

        const sessionData = session[0];
        // 进度基于计数列 uploadedChunks 计算（读一行即可，比 COUNT(*) 便宜，
        // 适合被前端高频轮询）；精确性由 completeUpload 的 COUNT(*) 复核兜底。
        const progress = Math.round((sessionData.uploadedChunks / sessionData.totalChunks) * 100);

        // Get uploaded chunk indices for resume
        // 断点续传的关键数据：从分片实表取出所有已落库的下标，客户端据此只补传缺口。
        const chunks = await db
          .select()
          .from(videoUploadChunks)
          .where(eq(videoUploadChunks.sessionId, input.sessionId));

        const uploadedChunkIndices = chunks.map((c) => c.chunkIndex);

        return {
          sessionId: input.sessionId,
          uploadedChunks: sessionData.uploadedChunks,
          totalChunks: sessionData.totalChunks,
          progress,
          status: sessionData.status,
          uploadedChunkIndices,
          fileName: sessionData.fileName,
        };
      } catch (error) {
        console.error("[Video Upload V2] Error getting progress:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to get upload progress",
        });
      }
    }),

  /**
   * cancelUpload — 取消上传并清除会话（mutation）。
   *
   * 权限：protected + 手动 admin 校验。
   * 副作用：DELETE `video_upload_chunks`（按 sessionId）+ DELETE `video_upload_sessions`。
   *   - 两条 DELETE 未包在事务里；但即使只成功了第二条，schema 上
   *     `videoUploadChunks.sessionId` 带 `onDelete: "cascade"` 外键，子行也会被级联删除，
   *     所以先删子表主要是为了在外键未生效（如引擎/约束缺失）时也能保证清干净。
   *   - 【注意】只清数据库，**不删 S3 上已上传的分片对象**，取消的上传会留下孤儿文件。
   * 幂等：sessionId 不存在时 DELETE 影响 0 行，依然返回 success:true。
   *
   * @param input.sessionId 会话句柄
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError INTERNAL_SERVER_ERROR 删除失败
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
          message: "Only admins can cancel uploads",
        });
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        // Delete chunks
        await db
          .delete(videoUploadChunks)
          .where(eq(videoUploadChunks.sessionId, input.sessionId));

        // Delete session
        await db
          .delete(videoUploadSessions)
          .where(eq(videoUploadSessions.id, input.sessionId));

        return {
          success: true,
          message: "Upload cancelled",
        };
      } catch (error) {
        console.error("[Video Upload V2] Error cancelling upload:", error);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to cancel upload",
        });
      }
    }),

  /**
   * getMissingChunks — 续传辅助：算出还缺哪些分片下标（query，无副作用）。
   *
   * 权限：protected + 手动 admin 校验。
   *
   * @param input.sessionId 会话句柄
   * @returns { sessionId, totalChunks, uploadedChunks, missingChunks, canResume }
   *          `canResume` 语义是「还有缺口可补传」，即 missingChunks 非空；
   *          全部传完时它为 false（此时客户端该做的是调 completeUpload）。
   *
   * ⚠️【与实际上传通道不一致】本 procedure 的缺口判定依赖会话行上的
   *   `uploadedChunkIds` JSON 列，而生产路径 `POST /api/upload/chunk`
   *   （server/_core/fastUpload.ts）只更新 `uploadedChunks` 计数与 chunks 表，
   *   **从不写 uploadedChunkIds**。因此走二进制通道上传后调用本接口，会把所有
   *   下标都报成缺失。`getProgress` 返回的 `uploadedChunkIndices`（取自 chunks 实表）
   *   才是可靠的续传依据。
   *
   * @throws TRPCError FORBIDDEN             非 admin
   * @throws TRPCError BAD_REQUEST           会话不存在
   * @throws TRPCError INTERNAL_SERVER_ERROR 查询失败
   */
  // Resume upload - get list of missing chunks
  getMissingChunks: protectedProcedure
    .input(
      z.object({
        sessionId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      if (ctx.user?.role !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only admins can access upload info",
        });
      }

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        const session = await db
          .select()
          .from(videoUploadSessions)
          .where(eq(videoUploadSessions.id, input.sessionId))
          .limit(1);

        if (session.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Session not found",
          });
        }

        const sessionData = session[0];
        const uploadedChunkIds = sessionData.uploadedChunkIds
          ? JSON.parse(sessionData.uploadedChunkIds as string)
          : [];

        // 全量补集扫描：遍历 0..totalChunks-1，凡不在已传集合中的即为缺口。
        // 复杂度 O(totalChunks × 已传数)（`includes` 是线性查找）；分片数上万时
        // 应改用 Set。这里选择线性数组是因为 uploadedChunkIds 本身就以 JSON 数组存库。
        const missingChunks: number[] = [];
        for (let i = 0; i < sessionData.totalChunks; i++) {
          if (!uploadedChunkIds.includes(i)) {
            missingChunks.push(i);
          }
        }

        return {
          sessionId: input.sessionId,
          totalChunks: sessionData.totalChunks,
          uploadedChunks: sessionData.uploadedChunks,
          missingChunks,
          canResume: missingChunks.length > 0,
        };
      } catch (error: any) {
        console.error("[Video Upload V2] Error getting missing chunks:", error);
        if (error.code === "BAD_REQUEST") throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to get missing chunks",
        });
      }
    }),
});
