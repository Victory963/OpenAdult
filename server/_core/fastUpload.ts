/**
 * Fast Binary Upload Endpoint
 *
 * Bypasses tRPC/JSON to accept raw binary chunks via multipart/form-data.
 * This eliminates Base64 encoding overhead (33%) and allows direct binary transfer.
 *
 * POST /api/upload/chunk
 *   - multipart/form-data with fields: sessionId, chunkIndex, file (binary)
 *   - Auth via admin_session_id cookie (same as admin-auth)
 *
 * ============================================================================
 * 二进制快速上传通道 (framework core / 传输层)
 * ----------------------------------------------------------------------------
 * 架构定位
 * --------
 * `server/_core/` 下的原始 Express 路由，是全项目**唯一刻意绕开 tRPC** 的写入通道。
 *
 * 为什么绕开 tRPC：tRPC 走 JSON + superjson，二进制必须先 Base64 编码，体积膨胀
 * 约 33%（4/3 倍），对动辄数 GB 的视频意味着巨大的带宽与 CPU 浪费。改用
 * `multipart/form-data` 后浏览器直接投递原始字节，零编码开销。
 *
 * 主要导出物
 * ----------
 * - `registerFastUpload(app)` —— 注册两个端点：
 *     * `POST /api/upload/chunk`             接收单个分片并落 S3 + 落库
 *     * `GET  /api/upload/status/:sessionId` 查询进度与已上传分片索引（断点续传用）
 *
 * 上下游依赖
 * ----------
 * 上游：`server/_core/index.ts` 注册；前端 `client/src/components/VideoUploadForm.tsx`
 *       用 fetch + FormData 并发调用（这也是前端约定「不直接 fetch」的少数例外）。
 * 下游：`storagePut()` (server/storage.ts) 写 S3；
 *       `video_upload_sessions` / `video_upload_chunks` 两张表；
 *       上传完成后由 `server/routers/video-upload-v2.ts` 的 finalize 流程把
 *       `videos.videoUrl` 写成 `multi-chunk:<sessionId>`，播放交给
 *       `server/_core/videoStream.ts` 做虚拟拼接。
 *
 * 分片上传状态机
 * --------------
 *   [tRPC 创建 session] → status=uploading, totalChunks=N, uploadedChunks=0
 *        ↓ 前端并发 POST /api/upload/chunk （每片一次，可乱序、可重试）
 *   [本模块] 每片：算 sha256 → 写 S3 → upsert chunk 行 → COUNT(*) 回写 uploadedChunks
 *        ↓ 前端轮询 GET /api/upload/status/:id 拿 uploadedIndices 补齐缺片
 *   [tRPC finalize] → status=completed，写 videos 记录
 *
 * 关键设计决策与坑
 * ----------------
 * 1. 鉴权用的是**管理员独立密码体系**（admin_session_id Cookie + JWT），不是
 *    OAuth 的 protectedProcedure —— 上传是后台管理动作。
 * 2. 分片元数据用 upsert（ON DUPLICATE KEY UPDATE），使重试幂等。
 * 3. 进度不做 `uploadedChunks + 1` 自增，而是每次 `COUNT(*)` 重算，
 *    以规避并发上传下的写-写竞态（见下方注释）。
 * ============================================================================
 */
import { Express, Request, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import { getDb } from "../db";
import { videoUploadSessions, videoUploadChunks } from "../../drizzle/schema";
import { storagePut } from "../storage";
import { eq, sql } from "drizzle-orm";
import { jwtVerify } from "jose";
import { ENV } from "./env";

// Store chunks in memory (max 100MB per chunk)
// memoryStorage：分片收下后立刻转发到 S3，不落本地磁盘 —— 容器是无状态的，
// 写临时文件既要处理清理又会踩容器磁盘配额。
// 100MB 上限来源：前端切片大小的上界，同时也是单请求内存占用的硬闸
// （并发 K 路上传时峰值内存约为 K x 分片大小，必须设界防止 OOM）。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max chunk
});

/**
 * 手工解析 Cookie 头。
 *
 * 为什么不用 cookie-parser 中间件：本模块是挂在 tRPC 之外的裸路由，注册时机早于
 * 应用级中间件链，直接读 header 更少耦合。
 *
 * @param cookieHeader 原始 `Cookie` 请求头，可能为 undefined
 * @returns  name → value 的字典；无 Cookie 时返回空对象
 * 副作用：无
 *
 * 注意 `val.join("=")`：JWT 的 base64url 段之间不含 `=`，但值里可能出现 `=` 填充，
 * 用 split 后 join 复原可避免把值截断。
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader.split(";").map((c) => {
      const [key, ...val] = c.trim().split("=");
      return [key, val.join("=")];
    })
  );
}

/**
 * 校验请求是否携带有效的管理员会话。
 *
 * 采用与 `server/routers/admin-auth.ts` 完全一致的签名方案：
 * HMAC 密钥 = `ENV.cookieSecret + "_admin"`。追加 `_admin` 后缀是**密钥域分离**：
 * 保证管理员令牌与普通用户 OAuth 令牌即使算法相同也无法互相冒充。
 *
 * @param req Express 请求，需带 `admin_session_id` Cookie
 * @returns   true = 已登录管理员；false = 无 Cookie / 签名无效 / 已过期 / 载荷缺 username
 * 副作用：无（纯校验，不刷新会话）
 * 说明：jwtVerify 失败会抛异常，这里用 catch 统一吞掉并返回 false，
 *       避免把「签名错误」与「令牌过期」的差异泄露给攻击者。
 */
async function verifyAdminSession(req: Request): Promise<boolean> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies["admin_session_id"];
  if (!token) return false;

  try {
    const secret = new TextEncoder().encode((ENV.cookieSecret || "fallback-secret") + "_admin");
    const { payload } = await jwtVerify(token, secret);
    return payload.username !== undefined;
  } catch {
    return false;
  }
}

/**
 * 在 Express 应用上注册二进制上传通道。
 * 由 `server/_core/index.ts` 启动时调用一次。
 *
 * @param app Express 实例
 * 副作用：注册 `POST /api/upload/chunk` 与 `GET /api/upload/status/:sessionId`
 * 权限级别：两个端点均为 admin（依赖 admin_session_id Cookie）
 */
export function registerFastUpload(app: Express) {
  /**
   * POST /api/upload/chunk
   * 接收单个视频分片，写入 S3 并登记元数据。
   *
   * 中间件链：`upload.single("file")` 先把 multipart 体解析进内存，
   * 文本字段落到 `req.body`（因此 chunkIndex 是**字符串**，需手工 parseInt），
   * 二进制落到 `req.file.buffer`。
   *
   * @param req.body.sessionId  上传会话 ID（video_upload_sessions 主键）
   * @param req.body.chunkIndex 分片序号，字符串形式的非负整数
   * @param req.file            分片二进制内容（字段名必须是 `file`）
   * @returns { success, chunkIndex, uploadedChunks, totalChunks, progress }
   *          progress 为 0-100 的整数百分比
   * 错误：401 未登录管理员 / 400 参数缺失或非法 / 400 会话不存在 / 500 DB 或 S3 失败
   * 副作用：
   *   1) 计算分片 sha256 校验和
   *   2) 写 S3 对象 `videos/<userId>/<sessionId>/chunk-<idx>`
   *   3) upsert `video_upload_chunks` 一行
   *   4) 回写 `video_upload_sessions.uploadedChunks`
   * 幂等性：同一 (sessionId, chunkIndex) 重复上传会覆盖，不会产生重复行，
   *         因此前端可安全重试失败分片。
   */
  // Single chunk upload endpoint
  app.post(
    "/api/upload/chunk",
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        // Verify admin auth
        const isAdmin = await verifyAdminSession(req);
        if (!isAdmin) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        // multipart 的文本字段一律是字符串；注意 chunkIndex 合法值含 "0"，
        // 所以必须用 `=== undefined` 判空而不能用 falsy 判断（否则第 0 片被拒）。
        const { sessionId, chunkIndex } = req.body;
        const file = req.file;

        if (!sessionId || chunkIndex === undefined || !file) {
          return res.status(400).json({ error: "Missing required fields: sessionId, chunkIndex, file" });
        }

        const chunkIdx = parseInt(chunkIndex, 10);
        if (isNaN(chunkIdx) || chunkIdx < 0) {
          return res.status(400).json({ error: "Invalid chunkIndex" });
        }

        const db = await getDb();
        if (!db) {
          return res.status(500).json({ error: "Database not available" });
        }

        // Get session
        // 先校验会话存在：既防止把孤儿分片写进 S3，也需要从中取 userId 来拼存储路径
        const session = await db
          .select()
          .from(videoUploadSessions)
          .where(eq(videoUploadSessions.id, sessionId))
          .limit(1);

        if (session.length === 0) {
          return res.status(400).json({ error: "Invalid session ID" });
        }

        const sessionData = session[0];
        const chunkBuffer = file.buffer;
        // sha256 校验和：供后续 finalize 阶段核对分片完整性（网络传输可能静默损坏），
        // 也可用于判断重传的分片内容是否真的一致。
        const checksum = crypto.createHash("sha256").update(chunkBuffer).digest("hex");

        // Upload chunk directly to S3
        // 存储键按 `videos/<userId>/<sessionId>/chunk-<idx>` 三级组织：
        // 按用户和会话分目录便于批量清理未完成的上传；注意**没有扩展名**，
        // 因此 storageProxy.getMimeType() 才需要靠 `videos/` 与 `chunk-` 前缀兜底推断类型。
        // Content-Type 固定为 octet-stream —— 单个分片不是合法的独立 MP4。
        const chunkStorageKey = `videos/${sessionData.userId}/${sessionData.id}/chunk-${chunkIdx}`;
        const { key } = await storagePut(chunkStorageKey, chunkBuffer, "application/octet-stream");

        // Save chunk metadata (use INSERT IGNORE to handle duplicates from retries)
        // upsert 而非纯 insert：网络抖动导致前端重传同一分片时，靠
        // (sessionId, chunkIndex) 唯一键把插入降级为更新，保证幂等、不产生重复行，
        // 也就保证了下面的 COUNT(*) 等于「去重后的已传分片数」。
        await db.insert(videoUploadChunks).values({
          sessionId,
          chunkIndex: chunkIdx,
          chunkSize: chunkBuffer.length,
          storageKey: key,
          checksum,
        }).onDuplicateKeyUpdate({ set: { storageKey: key, checksum } });

        // Count actual uploaded chunks from DB (race-condition safe)
        // 关键：进度**重算**而非自增。前端是并发上传的，若用
        // `SET uploadedChunks = uploadedChunks + 1`，两个并发请求会读到同一旧值再各自
        // 写回，造成计数丢失；而 COUNT(*) 每次都从分片表得到当前事实值，
        // 无论并发多少、重传多少次都收敛到正确结果。
        const chunkCountResult = await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(videoUploadChunks)
          .where(eq(videoUploadChunks.sessionId, sessionId));

        // 驱动层对 COUNT(*) 可能返回字符串（MySQL BIGINT），显式 Number 归一化
        const actualCount = Number(chunkCountResult[0]?.count ?? 0);

        // Update session progress atomically
        // 把事实值写回会话表，供状态查询端点与后台列表直接读取，免去每次 COUNT
        await db
          .update(videoUploadSessions)
          .set({
            uploadedChunks: actualCount,
          })
          .where(eq(videoUploadSessions.id, sessionId));

        const progress = Math.round((actualCount / sessionData.totalChunks) * 100);

        return res.json({
          success: true,
          chunkIndex: chunkIdx,
          uploadedChunks: actualCount,
          totalChunks: sessionData.totalChunks,
          progress,
        });
      } catch (error: any) {
        // 统一吞掉细节，只返回泛化错误信息（S3 密钥、SQL 语句等不应外泄）；
        // 前端据此对该分片重试即可。
        console.error("[Fast Upload] Error:", error);
        return res.status(500).json({ error: "Failed to upload chunk" });
      }
    }
  );

  /**
   * GET /api/upload/status/:sessionId
   * 查询某次上传会话的进度，支撑**断点续传**与并发上传的收尾对账。
   *
   * 关键返回字段是 `uploadedIndices`：已成功入库的分片序号（升序）。前端拿它与
   * 本地切片列表求差集，即可精确知道还缺哪几片并只补传缺失部分，
   * 而不必从头重传整个文件。
   *
   * @param req.params.sessionId 上传会话 ID
   * @returns { sessionId, uploadedChunks, totalChunks, progress, status, uploadedIndices }
   *          会话不存在时返回 200 + `{ status: "not_found" }`（而非 404，
   *          便于前端轮询逻辑统一处理）
   * 错误：401 未登录管理员 / 500 DB 不可用
   * 副作用：只读两张表，无写入
   * 权限级别：admin
   */
  // Batch status check for parallel uploads
  app.get("/api/upload/status/:sessionId", async (req: Request, res: Response) => {
    try {
      const isAdmin = await verifyAdminSession(req);
      if (!isAdmin) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { sessionId } = req.params;
      const db = await getDb();
      if (!db) {
        return res.status(500).json({ error: "Database not available" });
      }

      const session = await db
        .select()
        .from(videoUploadSessions)
        .where(eq(videoUploadSessions.id, sessionId))
        .limit(1);

      if (session.length === 0) {
        return res.json({ status: "not_found" });
      }

      const sessionData = session[0];
      const chunks = await db
        .select()
        .from(videoUploadChunks)
        .where(eq(videoUploadChunks.sessionId, sessionId));

      // 显式传比较函数：Array.prototype.sort 默认按字符串排序，
      // 会把 [1,2,10] 排成 [1,10,2]，前端做差集时就会误判。
      const uploadedIndices = chunks.map((c) => c.chunkIndex).sort((a, b) => a - b);

      return res.json({
        sessionId,
        uploadedChunks: sessionData.uploadedChunks,
        totalChunks: sessionData.totalChunks,
        progress: Math.round((sessionData.uploadedChunks / sessionData.totalChunks) * 100),
        status: sessionData.status,
        uploadedIndices,
      });
    } catch (error: any) {
      console.error("[Fast Upload] Status error:", error);
      return res.status(500).json({ error: "Failed to get status" });
    }
  });
}
